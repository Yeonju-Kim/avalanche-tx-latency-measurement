const ethers = require('ethers');
const Avalanche = require('avalanche').Avalanche;
const AWS = require('aws-sdk');
var parquet = require('parquetjs-lite');
const moment = require('moment');
const fs = require('fs');
const { type } = require('os');
const axios = require('axios');

require('dotenv').config();

const privateKey = process.env.SIGNER_PRIVATE_KEY;

const nodeURL = process.env.PUBLIC_RPC_URL;
const HTTPSProvider = new ethers.providers.JsonRpcProvider(nodeURL);

const chainId = 43113;
const avalanche = new Avalanche('api.avax-test.network', undefined, 'https', chainId);
const cchain = avalanche.CChain();

const wallet = new ethers.Wallet(privateKey);
const address = wallet.address;

var PrevNonce = 0; 

async function makeParquetFile(data) {
    var schema = new parquet.ParquetSchema({
        executedAt:{type:'TIMESTAMP_MILLIS'},
        txhash:{type:'UTF8'},
        startTime:{type:'TIMESTAMP_MILLIS'},
        endTime:{type:'TIMESTAMP_MILLIS'},
        chainId:{type:'INT64'},
        latency:{type:'INT64'},
        error:{type:'UTF8'}
    })

    var d = new Date()
    //20220101_032921
    var datestring = moment().format('YYYYMMDD_HHmmss')

    var filename = `${datestring}.parquet`

    // create new ParquetWriter that writes to 'filename'
    var writer = await parquet.ParquetWriter.openFile(schema, filename);

    await writer.appendRow(data)

    writer.close()

    return filename;
}

async function sendSlackMsg(msg) {
  axios.post(process.env.SLACK_API_URL, {
      'channel':process.env.SLACK_CHANNEL,
      'mrkdown':true,
      'text':msg
  }, {
      headers: {
          'Content-type':'application/json',
          'Authorization':`Bearer ${process.env.SLACK_AUTH}`
      }
  })
}

async function uploadToS3(data){
    const s3 = new AWS.S3();
    const filename = await makeParquetFile(data)
    const param = {
      'Bucket':process.env.S3_BUCKET,
      'Key':filename,
      'Body':fs.createReadStream(filename),
      'ContentType':'application/octet-stream'
    }
    await s3.upload(param).promise()
    fs.unlinkSync(filename) 
}
  
// Function to estimate max fee and max priority fee
const calcFeeData = async (maxFeePerGas = undefined, maxPriorityFeePerGas = undefined) => {
    // Get Base Fee: this value is just an estimate
    const baseFee = parseInt(await cchain.getBaseFee(), 16) / 1e9;

    // Calc MaxPriorityFeePerGas and MaxFeePerGas
    maxPriorityFeePerGas = maxPriorityFeePerGas == undefined ? parseInt(await cchain.getMaxPriorityFeePerGas(), 16) / 1e9 : maxPriorityFeePerGas;
    maxFeePerGas = maxFeePerGas == undefined ? baseFee + maxPriorityFeePerGas : maxFeePerGas;

    if(maxFeePerGas < maxPriorityFeePerGas) {
        throw("Error: Max fee per gas cannot be less than max priority fee per gas");
    }

    return {
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString()
    };
}

// Function to send AVAX
const sendAvax = async (amount, to, maxFeePerGas = undefined, maxPriorityFeePerGas = undefined, nonce = undefined) => {
    var data = {
        executedAt: new Date().getTime(),
        txhash: '',
        startTime: 0,
        endTime: 0,
        chainId: chainId,
        latency:0,
        error:'',
    } 

    try{
        const balance = await HTTPSProvider.getBalance(address) // getAssetBalance
        if(balance*(10**(-18)) < parseFloat(process.env.BALANCE_ALERT_CONDITION_IN_AVAX))
        { 
            // console.log(`Current balance of ${address} is less than ${process.env.BALANCE_ALERT_CONDITION_IN_AVAX} AVAX! balance=${balance*(10**(-18))}`)
            sendSlackMsg(`Current balance of <${process.env.SCOPE_URL}/address/${address}|${address}> is less than ${process.env.BALANCE_ALERT_CONDITION_IN_AVAX} AVAX! balance=${balance*(10**(-18))} AVAX`)
        }

        const latestNonce = await HTTPSProvider.getTransactionCount(address);
        if (latestNonce == PrevNonce) 
        {
          console.log(`Nonce ${latestNonce} = ${PrevNonce}`)
          return;
        }
        else{
          console.log(`Nonce ${latestNonce} != ${PrevNonce}`)
          PrevNonce = latestNonce
        }     

        // If the max fee or max priority fee is not provided, then it will automatically calculate using CChain APIs
        ({ maxFeePerGas, maxPriorityFeePerGas } = await calcFeeData(maxFeePerGas, maxPriorityFeePerGas));
        maxFeePerGas = ethers.utils.parseUnits(maxFeePerGas, "gwei");
        maxPriorityFeePerGas = ethers.utils.parseUnits(maxPriorityFeePerGas, "gwei");

        // Type 2 transaction is for EIP1559
        const tx = {
            type: 2,
            nonce: latestNonce,
            to, 
            maxPriorityFeePerGas,
            maxFeePerGas,
            value: ethers.utils.parseEther(amount),
            chainId,
        };
        tx.gasLimit = await HTTPSProvider.estimateGas(tx);

        // Sign transaction 
        const signedTx = await wallet.signTransaction(tx); //serialized ( unsigned tx , signature ) : rlp encoded (unsigned tx , signature)
        data.txhash = ethers.utils.keccak256(signedTx);

        // Write starttime 
        const start = new Date().getTime()
        data.startTime = start

        // Sending a signed transaction and waiting for its inclusion
        await HTTPSProvider.sendTransaction(signedTx);
        
        // Calculate latency 
        const end = new Date().getTime()
        data.endTime = end
        data.latency = end-start
        console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.error}`) 
    } catch(err){
        console.log("failed to execute.", err.toString())
        data.error = err.toString()
        console.log(`${data.executedAt},${data.chainId},${data.txhash},${data.startTime},${data.endTime},${data.latency},${data.error}`)
    }
    try{
        await uploadToS3(data)
    } catch(err){
        console.log('failed to s3.upload', err.toString())
    }
};

async function main(){
    const start = new Date().getTime()
    console.log(`starting tx latency measurement... start time = ${start}`)

    // run sendTx every SEND_TX_INTERVAL(sec).
    const interval = eval(process.env.SEND_TX_INTERVAL)
        setInterval(()=>{
        sendAvax("0.0", address);
    }, interval)
}

main();