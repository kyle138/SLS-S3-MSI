# SLS-S3-MSI
Serverless MSI processors and server  

Lambda triggered by uploads to S3 ```config.json:{stage}.bucket``` to process MSI and ZIP files for Google WDM deployment. It also generates the necessary XML files and a presigned CloudFront URL for security.   

## Notes:  
The SHA256 checksum isn't calculated on objects by default, it can be manually enabled at the time the object isuploaded but is buried in 3 submenus. (Really, Amazon?!?)  
There is no setting in S3 currently to enable checksums on all uploads in the bucket.
The current work-around is to have the lambda that's already being triggered by the upload to perform a copy-object command and enable the checksum on that copying. Yes, this work-around is _official_:  
https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-s3/classes/copyobjectcommand.html  

Also, Amazon converts the SHA256 checksum to Base64 so it will need to be converted back to hex.  
https://aws.amazon.com/getting-started/hands-on/amazon-s3-with-additional-checksums/?ref=docs_gateway/amazons3/checking-object-integrity.html  

The ```exiftool``` command does not exist natively in Lambda's nodejs runtime but it can be manually downloaded, modified, zipped up, and uploaded to Lambda as a Layer. This repo contains a helper script at ```/exiftool/exiftool.sh``` which will download the specified version from exiftool.org, modify its path to find the perl runtime in a second Lambda layer (more on that later), and create the ```exiftool.zip``` file. This zip file will need to be manually uploaded to Lambda as a Layer, that new Layer's ARN will need to be manually copied to ```serverless.yml:63```. More information available at the following link: https://dev.to/goceb/working-with-exif-iptc-and-xmp-in-aws-lambda-1g49  

The exiftool layer above relies on the perl runtime to execute. Conveniently for us metacpan maintains several publicly accessible Lambda Layers containing the perl runtime. Simply copy the ARN for the latest x86_64 perl runtime and paste it in ```serverless.yml:62```. The public Lambda perl layers maintained by metacpan can be found at the following link: https://metacpan.org/pod/AWS::Lambda

## Components::  
- **Layers:** 
  - ```CommonModules``` Lambda layer with the following NPM modules:
    - **p-exiftool**  - Nodejs wrapper for the exiftool, used to extract RevisionNumber guid from MSI files.
    - **mimetext**  - Generates rfc compliant message for SES:SendRawEmailCommand. The AWS documentation for this command is misleading, mimetext saves much time.  
  - ```perl runtime``` - The publicly available Lambda Layer maintained metacpan mentioned above. This layer must be listed before the exiftool layer.
  - ```exiftool``` - The manually uploaded exiftool.zip layer created above. This layer must be listed after the metacpan maintained perl layer.
- **Lambdas:**  
  - ```msiProcessor.js``` - Lambda triggered by ObjectCreated:* events in the S3 bucket specified in config.json.

## External Components:  
- **S3:**
  - ```config.json:{stage}.bucket``` - The S3 bucket that MSI files are uploaded to. Objects uploaded in the msi/ folder trigger the msiProcessor lambda. This S3 bucket must contain the following folders: 
      - **static/*** - For error messages and future use.
      - **msi/*** - Directory where MSI and ZIP files used with WDM will be uploaded to.
  - Configured for static website hosting.
  - Permissions set to allow public read access for all files in /static*
    ```
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Sid": "PublicReadGetObject",
          "Principal": "*",
          "Effect": "Allow",
          "Action": "s3:GetObject",
          "Resource": "arn:aws:s3:::{yourdomainbucket}/static*"
        }
      ]
    }
    ```
  - Further recommendations:
    - Name the bucket the same as the domain it will host
    - Create a lifecycle rule to periodically clean up the msi/ folder and incomplete multipart uploads.
- **CloudFront:**
  - ```config.json:{stage}.bucket``` - The CloudFront distribution to provide HTTPS for the S3 bucket above.
    - **Create Origin Paths**  
      - Default Origin:  
        - Custom type
        - S3 website endpoint as Origin domain 
        - Origin path set to **/static** (For future use)
      - MSI Origin:
        - S3 type
        - Origin Access: **Origin Access Control Settings** (Restrict access only to CloudFront)
        - Create CloudFront Public Key and Key Group. Record the Public Key ID for config.json:
          https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-trusted-signers.html
        - Select **Yes, update the bucket policy**
        - Also create new **Behavior** with Path Pattern **/msi/*** and using the Origin created in the previous step
          - Restrict viewer access **Yes**
          - Trusted authorization type **Trusted key groups (recommended)**
          - Add the key group created in the previous step
        - Go back and inspect the S3 bucket policy that CloudFront updated in the previous step. Change the **Sid:2** **Resource** to only apply to the **/msi/*** directory.
      - Error Pages:  
        - Create custom error response for 403 errors using /403.html
- **SES:**
  - ```config.json:{stage}.sesarn``` - The SES Verified Identy the Lambda will send emails from. 
    - Make sure to update config/config.json with the ARN for the verified identity to grant ses:SendRawEmail permissions to the Lambda.  

## FrontEnd:
- The **static/** folder will need to be uploaded to the S3 bucket to host the index.html and 403.html error messages.

## Configuration:  
- **config/** 
  - **config.json**:
    - **bucket** - "The name of the S3 bucket, this should match the domain used."
    - **keypairId** - Keypair ID creeated during CloudFront configuration
    - **privatekey** - Private Key associated with the Keypair ID stored on a single line with carriage returns and linebreaks replaced with ```\n```
    - **expdn** - Timeout for download URL in years, defaults to 3yrs.
    - **sender** - Email address for sending from. Must be validated email sender in SES.
    - **receiver** - Email address to send emails to.  
    - **sesarn** - The ARN for the SES Verified ARN that emails will be sent from.

## Credits:
By no means did I come up with this by myself. I drew heavy inspiration (and some code) from the links below:
- [AWS's documentation on setting SHA256 checksum on objects.](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-s3/classes/copyobjectcommand.html)
- [AWS's documentation on checking the SHA256 checksum.](https://aws.amazon.com/getting-started/hands-on/amazon-s3-with-additional-checksums/?ref=docs_gateway/amazons3/checking-object-integrity.html)
- [Goce's excellent article on getting exiftool working in Lambda.](https://dev.to/goceb/working-with-exif-iptc-and-xmp-in-aws-lambda-1g49)
- [MetaCpan's list of public Lambda Layers containing the perl runtime.](https://metacpan.org/pod/AWS::Lambda)
- [AWS's documentation for SES.SendRawEmailCommand is misleading, actually it's plain **WRONG**. The message must be submitted as a blob, muratgozel's NPM module helps with that.](https://github.com/muratgozel/MIMEText)