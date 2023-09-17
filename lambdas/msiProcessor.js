'use strict';

// add/configure modules
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { s3Client } from "../libs/s3Client.js";
import { sesClient } from "../libs/sesClient.js";
import { GetObjectAttributesCommand } from "@aws-sdk/client-s3";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { SendRawEmailCommand } from "@aws-sdk/client-ses";
import { getSignedUrl } from "@aws-sdk/cloudfront-signer";
import { createMimeMessage } from "mimetext";
import pexiftool from "p-exiftool";

// Globals
const settings = {};

// validateRequiredVar
// Checks if the supplied variable is of type string and has length
// @param {var} reqvar - the variable to check
// @return {promise} - Error or response object
function validateRequiredVar(reqvar) {
  return new Promise((resolve,reject) => {
    // Is the envar a string and have some length?
    // console.log(`validateRequiredVar:reqvar:: ${reqvar}`);  // DEBUG
    if(typeof reqvar === 'string' && reqvar.length > 0) {
      return resolve(true);
    } else {
      return reject(new Error('Missing Required Variable'));
    }
  }); // End Promise
} // End validateRequiredvar

// validateRecord
// Checks if the supplied record contains a bucket name and object key
// @record {object} - the object to check
// @return {promise} - array of validated records
function validateRecord(record) {
  // console.log(`validateRecord:record::`,JSON.stringify(record,null,2)); // DEBUG
  return Promise.all([
    validateRequiredVar(record.s3.bucket.name),
    validateRequiredVar(record.s3.object.key)
  ])
  .then(() => {
    return {
      Bucket: record.s3.bucket.name,
      Key: record.s3.object.key,
      ObjectAttributes: [ "Checksum","ObjectSize" ]
    }; 
  });
}// End validateRecord

// filterCopies
// Checks if the supplied record is the copy we just made and filters it out
// @record {object} - the object to check and filter
// @return {object} - the object, or nothing
function filterCopy(record) {
  return record?.eventName !== "ObjectCreated:Copy";
} // End filterCopy

// handleFiletypes
// Checks if the uploaded object is an MSI or ZIP, or other
// @records {array of objects} - See required keys below
// @record[i].Key {string} - The path/filename for the object
// @record[i].filetype {string} - The filetype for the object
// @return {promise.all} - The processed records
function handleFiletypes(records) {
  return Promise.all(records.map((record) => {
    return new Promise(async (resolve,reject) => {

      switch(record.Key.slice(record.Key.lastIndexOf('.')).toLowerCase()) {
        case '.msi':
          // console.log('File is .msi');  // DEBUG
          record.filetype = 'MSI';
          return await handleMsi(record)
          .then((resp) => {
            // console.log('case Msi: ',JSON.stringify(resp,null,2));  // DEBUG
            return resolve(resp);
          })
          .catch((err) => {
            return reject(err);
          });
        case '.zip':
          // console.log('File is a .zip');  // DEBUG
          record.filetype = 'ZIP';
          return await handleZip(record)
          .then((resp) => {
            // console.log('case Zip: ',JSON.stringify(resp,null,2));  // DEBUG
            return resolve(resp);
          })
          .catch((err) => {
            return reject(err);
          });
        default:
          record.filetype = 'UNK';
          return await handleUnk(record)
          .then((resp) => {
            // console.log('case Unk: ',JSON.stringify(resp,null,2));  // DEBUG
            return resolve(resp);
          });
      } // End switch
    }); // End Promise
  }));  // End Promise.all
} // end handleFiletypes

// handleZip
// Handler for uploaded objects of type 'zip'
// @record {object} - See required keys below:
// @record.Bucket {string} - The S3 bucket containing the zip object
// @record.Key {string} - The path/filename to the zip object.
// @return {promise} - The processed zip object
function handleZip(record) {
  return new Promise(async (resolve,reject) => {
    return await signUrl(record)
    .then(async (resp) => {
      // console.log(`handleZip: ${resp.url}`);
      return await sendMail(resp);
    })
    .catch((err) => {
      console.error('handleZip Error: ',err);
      return reject(err);
    });
  }); // End Promise
} // End handleZip

// handleMsi
// Handler for uploaded objects of type 'msi'
// @record {object} - See required keys below:
// @record.Bucket {string} - The S3 bucket containing the msi object.
// @record.Key {string} - The path/filename to the msi object.
// @return {promise} - The processed msi object
function handleMsi(record) {
  return new Promise(async (resolve,reject) => {
    // Process the record to ensure it has a ChecksumSHA256 value
    return await getSHA256(record)
    .then(async (resp) => {
      // console.log(`handleMsi1: ${resp.Checksum.ChecksumSHA256}`);  // DEBUG
      // Copy objects to local /tmp for processing with exiftool
      return await getS3Object(resp);
    })
    .then(async (resp) => {
      // console.log(`handleMsi2: `, JSON.stringify(resp,null,2)); // DEBUG
      // Process the local files with exiftool to get revisionNumber
      return await getRevisionNumber(resp);
    })
    .then(async (resp) => {
      // console.log(`handleMsi3: `, JSON.stringify(resp,null,2)); // DEBUG
      // Generate signed CF link for file
      return await signUrl(resp);
    })
    .then(async (resp) => {
      // console.log(`handleMsi4: `, JSON.stringify(resp,null,2)); // DEBUG
      // Send the email to IT
      return await sendMail(resp);
    })
    .catch((err) => {
      console.error('handleMsi Error: ',err);
      return reject(err);
    }); // End getSHA256 chain
  }); // End Promise
} // End handleMsi

// handleUnk
// Handler for uploaded objects of type 'unknown'
// @record {object} - See required keys below
// @record.Bucket {string} - The S3 bucket containing the unknown object.
// @record.Key {string} - The path/filename to the unknown object.
// @return {promise} - The processed unknown object
function handleUnk(record) {
  return new Promise(async (resolve,reject) => {
    return await sendMail(record)
    .then((resp) => {
      // console.log('handleUnk1: ',JSON.stringify(resp,null,2));  // DEBUG
      return resolve(resp);
    })
    .catch((err) => {
      console.error('handleUnk Error:',err);
      return reject(err);
    }); // End sendMail chain
  }); // End Promise
} // End handleUnk

// getSHA256
// Processes record to retrieve S3 object attributes
// @record {object} - the S3 object to process
// @return {promise} - Object containing bucket, key, [attrs]
function getSHA256(record) {
  return new Promise(async (resolve,reject) => {
    await s3Client.send(new GetObjectAttributesCommand(record))
    .then(async (resp) => {
      // console.log('getSha256:getAttributes resp: ',JSON.stringify(resp,null,2)); // DEBUG

      if(resp.Checksum?.ChecksumSHA256 == undefined) {
        record.Checksum = {ChecksumSHA256 : await copyObject(record)};
      } else {
        // S3 converts the SHA256 to base64, convert that back to hex.
        record.Checksum = {
          ChecksumSHA256: Buffer.from(resp.Checksum.ChecksumSHA256, "base64").toString('hex')
        };
      }
      return resolve(record);
    })
    .catch((err) => {
      console.error('getSHA256:err:: ',err);
      return reject(err);
    }); // End GetObjectAttributesCommand  
    
  }); // End promise
} // End getSHA256

// copyObject
// sha256 checksum is calculated by default but can be added with the copyobject command
// @s3obj {object} - the S3 object to copy. See required keys below:
// @s3obj.Bucket {string} - The S3 bucket containing the object.
// @s3obj.Key {string} - The path/filename for the object.
// @return {promise} - The hex encoded SHA256 string for the object.
function copyObject(s3obj) {
  return new Promise(async (resolve, reject) => {
    await s3Client.send(new CopyObjectCommand({
      Bucket: s3obj.Bucket,
      Key: s3obj.Key,
      CopySource: `/${s3obj.Bucket}/${s3obj.Key}`,
      ChecksumAlgorithm: "SHA256"
    }))
    .then((resp) => {
      // console.log('copyObject resp: ',JSON.stringify(resp,null,2));  // DEBUG
      if(resp.CopyObjectResult?.ChecksumSHA256) {
        // S3 converts the SHA256 to base64, convert that back to hex.
        return resolve(Buffer.from(resp.CopyObjectResult.ChecksumSHA256, "base64").toString('hex'));
      } else {
        throw new Error('Checksum not calculated.');
      }
    })
    .catch((err) => {
      console.error('cO err: ',err);
      return reject(err);
    }); // End CopyObjectCommand
  }); // End Promise
} // End copyObject

// getRevisionNumber
// Get the RevisionNumber from the provided MSI file
// @file {object} - The file object. See required keys below:
// @file.localpath {string} - The local path to the MSI file.
// @return {promise} - The Revision Number of the MSI file
function getRevisionNumber(file) {
  return new Promise(async (resolve, reject) => {
    // console.log('getRevisionNumber: ',JSON.stringify(file,null,2)); // DEBUG

    await validateRequiredVar(file?.localpath)
    .then(async () => {
      return await pexiftool(file.localpath)
      .then((metadata) => {
        // console.log('pexiftool results: ',JSON.stringify(metadata,null,2));  // DEBUG
        if(metadata?.revisionNumber.length > 0) {
          file.revisionNumber = metadata.revisionNumber;
          return resolve(file);
        } else {
          return resolve("Revision Number not found in metadata.");
        }
      });
    })
    .catch((err) => {
      console.error("getRevisionNumber error: ",err);
      return reject("Unable to retrieve metadata.");
    }); // End pexiftool
  }); // End Promise
} // End getRevisionNumber

// getS3Object
// Retrieve object from S3 and save locally in /tmp
// @s3obj {object} - The S3 object to retrieve. See required keys below:
// @s3obj.Bucket {string} - The S3 bucket containing the object.
// @s3obj.Key {string} - The path/filename for the object.
// @return {promise} - The path/filename of the local file.
function getS3Object(s3obj) {
  return new Promise(async (resolve,reject) => {
    // console.log('getS3Object: ',JSON.stringify(s3obj,null,2));  // DEBUG
    await s3Client.send(new GetObjectCommand({
      Bucket: s3obj.Bucket,
      Key: s3obj.Key
    }))
    .then(async (resp) => {
      if( resp.Body instanceof Readable) {
        // Create the S3 object's full Path in /tmp/ 
        s3obj.localpath = `/tmp/${s3obj.Key}`;
        // First create the subdirectories
        await mkdir(s3obj.localpath.slice(0, s3obj.localpath.lastIndexOf('/')), { recursive: true });
        const writeStream = createWriteStream(s3obj.localpath);
        resp.Body
          .pipe(writeStream)
          .on("error", (err) => reject(err))
          .on("close", () => resolve(s3obj));
      }
    })
    .catch((err) => {
      console.error('getS3Object Error: ',err);
      return reject(err);
    }); // End GetObjectCommand
  }); // End Promise
} // End getS3Object

// signUrl 
// Generate signed URL for MSI file in S3
// @s3obj {object} - The S3 object to generate a signed URL for. See required keys below:
// @s3obj.Bucket {string} - The S3 bucket containing the object.
// @s3obj.Key {string} - The path/filename for the object.
// @return {promise} - The signed URL
function signUrl(s3obj) {
  return new Promise(async (resolve,reject) => {
    try {
      // console.log('signUrl: ',JSON.stringify(s3obj,null,2));  // DEBUG
      s3obj.url = getSignedUrl({
        url: `https://${s3obj.Bucket}/${s3obj.Key}`,
        dateLessThan: new Date(new Date().setFullYear(new Date().getFullYear() + settings.expdn)),
        keyPairId: process.env.KEYPAIRID,
        privateKey: process.env.PRIVATEKEY
      });

      // console.log(`signed URL: ${s3obj.url}`);  // DEBUG
      return resolve(s3obj);
    } 
    catch (err) {
      console.error(err);
      return reject(err);
    }
  }); // End Promise
} // End signUrl

// generateUnkMail
// Generate email message for 'unknown' objects
// @sesObj {object} - See required keys below:
// @sesObj.Key {string} - The path/filename of the object.
// @return {promise} - The generated mimetext message.
function generateUnkMail(sesObj) {
  return new Promise(async (resolve,reject) => {
    const msg = createMimeMessage();
    msg.setSender(process.env.SENDER);
    msg.setTo(process.env.RECEIVER);
    msg.setSubject(`[S3 MSI Processor] Unsupported filetype for file: ${sesObj.Key}`);
    msg.addMessage({
      contentType: 'text/plain',
      data: 'Hello, \n\n' +
            `I'm sorry but the file ${sesObj.Key} is not supported.  Only objects of type .MSI and .ZIP are supported.\n\n` +
            'Thank you.\n'
    });
    msg.addMessage({
      contentType: 'text/html',
      data: 'Hello,<br><br>' + 
            `I'm sorry but the file <B>${sesObj.Key}</B> is not supported. Only Objects of type .MSI and .ZIP are supported.<BR><BR>` + 
            'Thank you.'
    });
    return resolve(msg);
  }); // End Promise
} // End generateUnkMail

// generateZipMail
// Generate email message for 'zip' objects
// @sesObj {object} - See required keys below:
// @sesObj.Key {string} - The path/filename of the object.
// @sesObj.url {string} - The signed CF url for the object.
// @return {promise} - The generated mimetext message.
function generateZipMail(sesObj) {
  return new Promise(async (resolve,reject) => {
    const msg = createMimeMessage();
    msg.setSender(process.env.SENDER);
    msg.setTo(process.env.RECEIVER);
    msg.setSubject(`[S3 MSI Processor] Signed URL for ${sesObj.Key}`);
    msg.addMessage({
      contentType: 'text/plain',
      data: 'Hello,\n\n' +
            `The signed URL for the file ${sesObj.Key} is below: \n\n` +
            `sesObj.url \n\n`  +
            'Thank you.\n'
    });
    msg.addMessage({
      contentType: 'text/html',
      data: 'Hello,<br><br>' + 
            `The signed URL for the file <B>${sesObj.Key}</B> is below:<br><br>` + 
            `${sesObj.url} <br><br>` + 
            'Thank you.'
    });
    return resolve(msg);
  }); // End Promise
} // End generateZipMail

// generateMsiMail
// Generate email message for 'msi' objects
// @sesObj {object} - See required keys below:
// @sesObj.Key {string} - The path/filename of the object.
// @sesObj.url {string} - The signed CF url for the object.
// @sesObj.Checksum.ChecksumSHA256 {string} - The hex encoded SHA256 sum for the object.
// @sesObj.revisionNumber {string} - The revisionNumber GUID for the MSI file.
// @return {promise} - The generated mimetext message.
function generateMsiMail(sesObj) {
  return new Promise(async (resolve,reject) => {
    // Generate attachment filename based off of the msi file uploaded.
    let filename = sesObj.Key.slice(sesObj.Key.lastIndexOf('/')+1).replace(/\.msi$/ig,'.xml');

    // Build the XML file to attach to the email.
    let xmlContents = [
      '<MsiInstallJob id="">',
      '  <Product Version="1.0.0">',
      '    <Download>',
      '      <ContentURLList>',
      `        <ContentURL>${sesObj.url.replaceAll('&','&amp;')}</ContentURL>`,
      '      </ContentURLList>',
      '    </Download>',
      '    <Enforcement>',
      '      <CommandLine>/quiet /norestart</CommandLine>',
      '      <TimeOut>5</TimeOut>',
      '      <RetryCount>3</RetryCount>',
      '      <RetryInterval>5</RetryInterval>',
      '    </Enforcement>',
      '    <Validation>',
      `      <FileHash>${sesObj.Checksum.ChecksumSHA256}</FileHash>`,
      '    </Validation>',
      '  </Product>',
      '</MsiInstallJob>'
    ];

    // Generate the OMA-URI to use for this custom policy
    let omauri = `./Device/Vendor/MSFT/EnterpriseDesktopAppManagement/MSI/${sesObj.revisionNumber.replace('{','%7B').replace('}','%7D')}/DownloadInstall`;

    // Build the message
    const msg = createMimeMessage();
    msg.setSender(process.env.SENDER);
    msg.setTo(process.env.RECEIVER);
    msg.setSubject(`[S3 MSI Processor] Signed URL and XML file for ${sesObj.Key}`);
    msg.addAttachment({
      filename: filename,
      contentType: 'text/xml',
      data: Buffer.from(xmlContents.join('\n'), 'utf8').toString("base64")
    });
    msg.addMessage({
      contentType: 'text/plain',
      data: 'Hello,\n\n' +
            `The properties for the file ${sesObj.Key} are below: \n` +
            `  ChecksumSHA256: ${sesObj.Checksum.ChecksumSHA256} \n`  +
            `  RevisionNumber: ${sesObj.revisionNumber} \n`  +
            `  OMA-URI: ${omauri} \n`  +
            `  Signed URL: ${sesObj.url} \n\n`  +
            `The MSI Install XML file ${filename} is attached. \n\n`  +
            'Thank you.\n'
    });
    msg.addMessage({
      contentType: 'text/html',
      data: 'Hello,<br><br>' + 
            `The properties for the file <B>${sesObj.Key}</B> are below:<BR>` + 
            '<ul>' +
            `  <li><B>ChecksumSHA256:</B> ${sesObj.Checksum.ChecksumSHA256}</li> ` +
            `  <li><B>RevisionNumber:</B> ${sesObj.revisionNumber}</li> ` +
            `  <li><B>Encoded Revision Number:</B> ${sesObj.revisionNumber.replace('{','%7B').replace('}','%7D')}</li> ` +
            `  <li><B>OMA-URI:</B> ${omauri}</li> ` +
            `  <li><B>Signed URL:</B> ${sesObj.url}</li> ` +
            '</ul><br>' +
            `The MSI Install XML file <B>${filename}</B> is attached.<BR><BR>` +
            'Thank you.'
    });
    return resolve(msg);
  }); // End Promise
} // End generateMsiMail


// sendEmail
// Send email to ITSupport
// @sesObj {object} - See required keys below:
// @sesObj.filetype {string} - The filetype for the object.
function sendMail(sesObj) {
  return new Promise(async (resolve,reject) => {
    // Build the body for the email message.
 
    let message;

    switch(sesObj.filetype) {
      case 'UNK':
        message = await generateUnkMail(sesObj);
        break;
      case 'ZIP':
        message = await generateZipMail(sesObj);
        break;
      case 'MSI':
        message = await generateMsiMail(sesObj);
        break;
      default:
        console.error("sendMail:switch::Error::: ",JSON.stringify(sesObj,null,2));
        return reject(new Error('SendMail error.'));
    } // End Switch
 
    const params = {
      Destinations: message.getRecipients({type: 'to'}).map(box => box.addr),
      RawMessage: {
        Data: Buffer.from(message.asRaw(), 'utf8')
      },
      Source: message.getSender().addr
    };

    await sesClient.send(new SendRawEmailCommand(params))
    .then((resp) => {
      // console.log('sesSendResp: ',resp);  // DEBUG
      sesObj.sesMessageId = resp.MessageId;
      return resolve(sesObj);
    })
    .catch((err) => {
      console.error(err);
      return reject(err);
    });
  }); // End Promise
} // End sendMail

// ************
// Main handler
export const handler = async (event) => {
  console.log('Received event: ' + JSON.stringify(event,null,2)); // DEBUG:

  // Check if KEYPAIRID is set as an environment variable
  if (!process.env.KEYPAIRID) {
    console.error("process.env.KEYPAIRID is missing.");
    return;
  }

  // Check if PRIVATEKEY is set as an environment variable
  if (!process.env.PRIVATEKEY) {
    console.error("process.env.PRIVATEKEY is missing.");
    return;
  }

  // Check if SENDER is set as an environment variable
  if (!process.env.SENDER) {
    console.error("process.env.SENDER is missing.");
    return;
  }

  // Check if RECEIVER is set as an environment variable
  if (!process.env.RECEIVER) {
    console.error("process.env.RECEIVER is missing.");
    return;
  }

  // Check if EXPDN is set as an environment variable, if not default to 3.
  settings.expdn = process.env.hasOwnProperty('EXPDN') ? Number(process.env.EXPDN) : 3;

  // Batch job seems to trigger 1 lambda per object, but let's Promise.all[] for all records to be safe...
  // But, some of these records will be the object we just copied, so filter those out first.
  await Promise.all(
    event.Records.filter(filterCopy).map(async (record) => await validateRecord(record))
  )
  .then(async (records) => {
    console.log('records1: ',JSON.stringify(records,null,2)); // DEBUG
    // It's possible the filter removed all records, if so shut down the lambda.
    if(records.length < 1) throw 'notanerror';
    
    // Proceed based on file extension of uploaded object:
    return await handleFiletypes(records);
  })
  .then((records) => {
    console.log('records2: ',JSON.stringify(records,null,2)); // DEBUG
    
    // All done, shut down the Lambda
    return records.sesMessageId;
  })
  .catch((err) => {
    console.error('err:',err);
    if(err === 'notanerror') {
      console.log("No valid events remained."); 
      // Nothing to do, shut down the Lambda
      return "Nothing to do.";
    } else {
      // Return the error and shut down the Lambda
      return err;
    }
  }); // End Promise.all chain

};  // End handler
