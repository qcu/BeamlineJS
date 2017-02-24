/*jshint esversion: 6 */

// add stage for creating new branch and PR -- DEV/QA
// move everything to yaml configuration - validate yaml config file
// make it work on github.com & private github as well
// add ${LATEST} and CURR_STABLE version test result assertions
// add stage add security scan -- use  appsec or retire.js
// add stage add Artemis integration
// send artifacts to slack channel (won't work with webhook, need to use token)

// DONE -
// add stage for creating new branch and PR -- FORK
// add stage function code SHA verification
// add ${LATEST} and CURR_STABLE test stages
// take care of multi-region deployment

const path = require('path');
const execSync = require('child_process').execSync;
const git = require('lambda-git')({targetDirectory: "/tmp/pipeline/git"});
const LambdaSDK = require('./lambdaSDK.js');
const fs = require('fs');
const archiver = require('archiver');
const crypto = require('crypto');

exports.BASE_DIR = '/tmp/pipeline';
exports.HOME_DIR = path.join(exports.BASE_DIR, 'git');
exports.BUILD_DIR = path.join(exports.BASE_DIR, 'build');

var logUrl = function(logGroupName,logStreamName, startTime) {
  return `https://console.aws.amazon.com/cloudwatch/home?region=${process.env.AWS_REGION}#logEvent:` +
    `group=${encodeURIComponent(logGroupName)};` +
    `stream=${encodeURIComponent(logStreamName)};` +
    `start=${encodeURIComponent(startTime.toISOString().slice(0, 19))}Z`
};

var testFunction = function(lambda, functionName, qualifier, slackARN, slackSub, payload, callback) {
  if (typeof(qualifier) === "undefined" || qualifier === null) qualifier = "$LATEST";
  // testing deployed lambda function
  this.lambda.getFunctionInfo(functionName)
  .then(function (functionData) {
      this.lambda.invokeByRequest(functionData.functionName, qualifier, payload)
      .then(function (data) {
        slackMessage = "Stage: Testing of lambda function completed:\n" + functionName + ":" + qualifier;
        this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
        callback(data);
      })
      .catch(function (err) {
        console.log("ERROR: " + err);
        slackMessage = "Stage: Testing of lambda function has failed:\n" + functionName + ":" + qualifier
        this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
        callback(err);
      });
  })
  .catch(function (err) {
    console.log("ERROR: " + err);
    slackMessage = "Stage: Testing of lambda function has failed because function does not exists:\n" + functionName + ":" + qualifier
    this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
    callback(err);
  });
};

var publishVersion = function(lambda, functionName, slackARN, slackSub, callback) {
  // publish the latest version
  this.lambda.publishVersion(functionName, function (version) {
    console.log("published version: " + version);
    slackMessage = "Stage: Publish new version of lambda function completed";
    this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
    callback(version);
  });
};

var manageAliases = function(lambda, functionName, version, slackARN, slackSub, callback) {
  this.lambda.getAliases(functionName)
  .then(function(aliasData) {
      console.log(aliasData);
      if (aliasData === undefined || (aliasData.CURR_STABLE === undefined && aliasData.LAST_STABLE === undefined)) {
        //create new CURR_STABLE alias
        this.lambda.createAlias(functionName, 'CURR_STABLE', version)
        .then(function(currStableAliasData){
          console.log(currStableAliasData);
          // create new LAST_STABLE alias
          this.lambda.createAlias(functionName, 'LAST_STABLE', version)
          .then(function(lastStableAliasData) {
            console.log(lastStableAliasData);
            slackMessage = "Stage: CURR_STABLE and LAST_STABLE aliases created with version:" + version;
            this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
            callback("aliases created");
          })
          .catch(function(lastStableAliasError) {
            console.log("ERROR: " + lastStableAliasError);
            slackMessage = "Stage: CURR_STABLE and LAST_STABLE aliases creation has failed for version:" + version;
            this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
            callback(lastStableAliasError);
          });
        })
        .catch(function(currStableAliasError){
          console.log("ERROR: " + currStableAliasError);
          slackMessage = "Stage: CURR_STABLE and LAST_STABLE aliases creation has failed for version:" + version;
          this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
          callback(currStableAliasError);
        });
      } else {
        //update CURR_STABLE alias version
        this.lambda.updateAlias(functionName, 'CURR_STABLE', version)
        .then(function(updateCurrStableAliasData) {
          console.log(updateCurrStableAliasData);
          // update LAST_STABLE alias version
          this.lambda.updateAlias(functionName, 'LAST_STABLE', aliasData.CURR_STABLE)
          .then(function(updateLastStableAliasData) {
            console.log(updateLastStableAliasData);
            slackMessage = "Stage: Update aliases completed. CURR_STABLE alias is: " + version + " and LAST_STABLE alias is: " + aliasData.CURR_STABLE;
            this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
            callback("alias versions updated");
          })
          .catch(function(updateLastStableAliasError) {
            console.log("ERROR: " + updateLastStableAliasError);
            slackMessage = "Stage: CURR_STABLE and LAST_STABLE aliases update has failed for version:" + version;
            this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
            callback(updateLastStableAliasError);
          });
        })
        .catch(function(updateCurrStableAliasError){
          console.log("ERROR: " + updateCurrStableAliasError);
          slackMessage = "Stage: CURR_STABLE and LAST_STABLE aliases update has failed for version:" + version;
          this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
          callback(updateCurrStableAliasError);
        });
      }
  })
  .catch(function(err) {
      console.log(err);
      slackMessage = "Stage: Manage alias has failed because function not found";
      this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
      callback(err);
  });
};

exports.handler = function (event, context) {
  //set this so that npm modules are cached in writeable directory. The default HOME directory /home/xxxxx is read-only
  // file system.
  process.env['HOME']='/tmp';
  process.env['GIT_HUB_REPO_URL'] = "https://6d87c432776b67825c4b4b7d8e6c2021e649aeb0@github.com" + "/" + event.GIT_HUB_REPO_URL + ".git";
  process.env['PROJECT_NAME'] = event.PROJECT_NAME;
  process.env['USER_ID'] = event.userId;
  process.env['REQUEST_ID'] = context.awsRequestId;
  process.env['GIT_TOKEN'] = '6d87c432776b67825c4b4b7d8e6c2021e649aeb0';
  process.env['ORG'] = event.organization;

  console.log(process.env);

  const invokedFunctionARN = context.invokedFunctionArn;
  const arnItems = invokedFunctionARN.split(":");
  const region = arnItems[3];
  const accountID = arnItems[4];
  const slackARN = "arn:aws:lambda:" + region + ":" + accountID + ":function:slack-notify";
  const toBeDeployedFunctionARN = "arn:aws:lambda:" + region + ":" + accountID + ":function:" + event.PROJECT_NAME + "-" + event.userId;
  const bucketName = "beamline-bucket-" + region;
  process.env['BUCKET_NAME'] = bucketName;
  this.lambda = new LambdaSDK();

  // blow away the /tmp directory for before and after execution of this lambda function.
  // need to keep this Transient.
  execSync('find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} +', {stdio:[0,1,2]});

  var slackSub = "Beamline update:" + event.PROJECT_NAME + " <"+ logUrl(context.logGroupName, context.logStreamName, new Date()) + "|" + context.awsRequestId + ">";
  var slackMessage = "Git URL: " + event.GIT_HUB_REPO_URL;
  slackMessage += "\nLambda Log Stream: <" + logUrl(context.logGroupName, context.logStreamName, new Date()) + "|Link to Stream>";
  this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});

  //setup environment stage
  execSync(`
    if ! [ -d ${exports.HOME_DIR} ]; then
      mkdir -p ${exports.HOME_DIR}
      cp -r ${__dirname}/. ${exports.HOME_DIR}
      tar -C ${exports.HOME_DIR} -xf ${__dirname}/node_modules/lambda-git/git-2.4.3.tar
    fi
  `, {stdio:[0,1,2]});
  var slackMessage = "Stage: Build environment setup completed";

  // clone stage
  execSync(`
    mkdir -p ${exports.BUILD_DIR}
    cd ${exports.BUILD_DIR}/
    git clone ${process.env.GIT_HUB_REPO_URL}
  `, {stdio:[0,1,2]});
  slackMessage += "\nStage: Cloning of repository completed";

  // install dependencies stage
  execSync(`
    cd ${exports.BUILD_DIR}/${process.env.PROJECT_NAME}/
    npm install
  `, {stdio:[0,1,2]});
  slackMessage += "\nStage: Install NPM modules completed";

  // check code quality stage
  execSync(`
    cd ${exports.BUILD_DIR}/${process.env.PROJECT_NAME}/
    npm run quality
  `, {stdio:[0,1,2]});
  slackMessage += "\nStage: Run code quality checks completed";

  // run code coverage & test cases
  execSync(`
    cd ${exports.BUILD_DIR}/${process.env.PROJECT_NAME}/
    npm run cover
    npm run check_coverage
  `, {stdio:[0,1,2]});
  slackMessage += "\nStage: Run unit tests and code coverage checks completed";

  var zipFile = exports.BUILD_DIR + "/" + process.env.PROJECT_NAME + ".zip";
  var output = fs.createWriteStream(zipFile);
  var archive = archiver('zip', {
      zlib: { level: 9 } // Sets the compression level.
  });

  /**
  * Need to learn how to clean up this below code....nested hell :-(
  * Below code will
  * a) create a lambda function if it does not exists OR
  * b) update function code and configuration if it already exists
  * c) perform smoke testing after delployment on ${LATEST} version
  * d) if test is successful then publish new version
  * e) Set CURR_STABLE & LAST_STABLE alias to new version if this is first version of the function
  *    else set CURR_STABLE to new version and LAST_STABLE to previous CURR_STABLE version.
  */
  // listen for all archive data to be written
  output.on('close', function() {
    console.log(archive.pointer() + ' total bytes');
    console.log('archiver has been finalized and the output file descriptor has closed.');
    var shasum = crypto.createHash('sha256');
    fs.createReadStream(zipFile)
    .on("data", function (chunk) {
        shasum.update(chunk);
    })
    .on("end", function () {
        var codeSHA256 = shasum.digest('base64');
        this.lambda = new LambdaSDK();
        execSync(`
          cd ${exports.BUILD_DIR}/
          node ${__dirname}/s3Uploader.js --bucket_name ${process.env.BUCKET_NAME} --abs_file_path ${exports.BUILD_DIR}/${process.env.PROJECT_NAME}.zip --fileName RELEASE/FORK/${process.env.PROJECT_NAME}-${process.env.USER_ID}.zip
        `, {stdio:[0,1,2]});
        slackMessage += "\nStage: Deployment package created and uploaded to S3 bucket ";
        this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
        this.lambda.getFunctionInfo(toBeDeployedFunctionARN)
        .then(function (functionData) {
            console.log("updating function code and configuration");
            this.lambda.updateLambdaCode(
              functionData.functionName, bucketName,
              "RELEASE/FORK/" + process.env.PROJECT_NAME + "-"+ process.env.USER_ID + ".zip"
            )
            .then(function() {
              this.lambda.getFunctionInfo(toBeDeployedFunctionARN)
              .then(function (functionData) {
                console.log("lamb:" + functionData.sha256);
                console.log("new:" + codeSHA256);
                if (functionData.sha256 === codeSHA256) {
                  slackMessage = "Stage: Lambda function code is updated";
                  this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
                  // update function configuration
                  this.lambda.updateLambdaConfiguration(
                    functionData.functionName,
                    "index.handler",
                    "arn:aws:iam::686218048045:role/lambda_role",
                    "Sample function",
                    128,
                    30
                  )
                  .then(function (data) {
                    slackMessage = "Stage: Lambda function configuration is updated";
                    this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
                    // test deployed function & configuration
                    testFunction(this.lambda, toBeDeployedFunctionARN, null, slackARN, slackSub, {}, function(result) {
                      console.log(result);
                      if (result.StatusCode === 200) {
                        // publish new Version
                        publishVersion(this.lambda, toBeDeployedFunctionARN, slackARN, slackSub, function(version) {
                          manageAliases(this.lambda, toBeDeployedFunctionARN, version, slackARN, slackSub, function(aliasData) {
                            // test the function with CURR_STABLE alias
                            testFunction(this.lambda, toBeDeployedFunctionARN, 'CURR_STABLE', slackARN, slackSub, {}, function(aliasResult) {
                              if (aliasResult.StatusCode === 200) {
                                execSync(`
                                  cd ${exports.BUILD_DIR}/${process.env.PROJECT_NAME}/
                                  git checkout -qf -b pr-${process.env.REQUEST_ID}
                                  git config user.name ${process.env.USER_ID}
                                  git config push.default matching
                                  git push origin pr-${process.env.REQUEST_ID}

                                  curl -v -b -X POST \
                                    -H "Content-Type: application/json" \
                                    -H "Authorization: token ${process.env.GIT_TOKEN}" \
                                    -d '{
                                      "title":"Pull submitted by beamlineJS for RequestID:'"${process.env.REQUEST_ID}"'",
                                      "body": "This Pull Request has passed all beamlineJS stages and is ready for Merge into Develop",
                                      "head": "'"${process.env.ORG}"':pr-'"${process.env.REQUEST_ID}"'",
                                      "base":"develop"
                                    }' \
                                    "https://api.github.com/repos/GaurangBhatt/sample-lambda/pulls"
                                `, {stdio:[0,1,2]});
                                // add more stages
                                console.log("all stages completed.");
                                execSync('find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} +', {stdio:[0,1,2]});
                              } else {
                                slackMessage = "Stage: Testing of lambda function has failed using CURR_STABLE version";
                                this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
                                context.fail("Stage: Testing of lambda function has failed");
                              }
                            });
                          });
                        });
                      } else {
                        slackMessage = "Stage: Testing of lambda function has failed using ${LATEST} version";
                        this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
                        context.fail("Stage: Testing of lambda function has failed");
                      }
                    });
                  })
                  .catch(function (error) {
                    console.log("ERROR: " + error);
                    slackMessage = "Stage: Update lambda function configuration has failed";
                    this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
                    context.fail("Stage: Update lambda function configuration has failed");
                  });
                } else {
                  slackMessage = "Stage: Lambda function code update has failed. SHA256 mismatch between stored code and uploaded code.";
                  this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
                  context.fail("Stage: Lambda function code update has failed. SHA256 mismatch between stored code and uploaded code.");
                }
              });
            });
        })
        .catch(function (err) {
          console.log("ERROR: ", err.message);
          if (err.code === 'ResourceNotFoundException' && err.statusCode === 404) {
              console.log("Creating lambda function");
              this.lambda.createLambda(
                  process.env.PROJECT_NAME + "-" + event.userId,
                  bucketName,
                  "RELEASE/FORK/" + process.env.PROJECT_NAME + "-"+ process.env.USER_ID + ".zip",
                  "index.handler",
                  "arn:aws:iam::686218048045:role/lambda_role",
                  128,
                  30,
                  "Sample function"
              )
              .then(function(){
                this.lambda.getFunctionInfo(toBeDeployedFunctionARN)
                .then(function(functionData){
                  console.log("lamb:" + functionData.sha256);
                  console.log("new:" + codeSHA256);
                  if (functionData.sha256 === codeSHA256) {
                    slackMessage = "Stage: Lambda function code & configuration is deployed";
                    this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
                    testFunction(this.lambda, toBeDeployedFunctionARN, null, slackARN, slackSub, {}, function(result) {
                      if (result.StatusCode === 200) {
                        // publish new Version
                        publishVersion(this.lambda, toBeDeployedFunctionARN, slackARN, slackSub, function(version) {
                          manageAliases(this.lambda, toBeDeployedFunctionARN, version, slackARN, slackSub, function(aliasData) {
                            // test the function with CURR_STABLE alias
                            testFunction(this.lambda, toBeDeployedFunctionARN, 'CURR_STABLE', slackARN, slackSub, {}, function(aliasResult) {
                              if (aliasResult.StatusCode === 200) {
                                execSync(`
                                  cd ${exports.BUILD_DIR}/${process.env.PROJECT_NAME}/
                                  export ORG=${process.env.ORG}
                                  git checkout -qf -b pr-${process.env.REQUEST_ID}
                                  git config user.name ${process.env.USER_ID}
                                  git config push.default matching
                                  git push origin pr-${process.env.REQUEST_ID} &> /dev/null

                                  curl -v -b -X POST \
                                    -H "Content-Type: application/json" \
                                    -H "Authorization: token ${process.env.GIT_TOKEN}" \
                                    -d '{
                                      "title":"Pull submitted by beamlineJS for RequestID:'"${process.env.REQUEST_ID}"'",
                                      "body": "This Pull Request has passed all beamlineJS stages and is ready for Merge into Develop",
                                      "head": "'"${process.env.ORG}"':pr-'"${process.env.REQUEST_ID}"'",
                                      "base": "develop"
                                    }' \
                                    "https://api.github.com/repos/GaurangBhatt/sample-lambda/pulls"
                                `, {stdio:[0,1,2]});
                                // add more stages
                                console.log("all stages completed.");
                                execSync('find /tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} +', {stdio:[0,1,2]});
                              } else {
                                slackMessage = "Stage: Testing of lambda function has failed using CURR_STABLE version";
                                this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
                                context.fail("Stage: Testing of lambda function has failed");
                              }
                            });
                          });
                        });
                      } else {
                        slackMessage = "Stage: Testing of lambda function has failed using ${LATEST} version";
                        this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
                        context.fail("Stage: Testing of lambda function has failed");
                      }
                    });
                  } else {
                    slackMessage = "Stage: Create lambda function code & configuration has failed";
                    this.lambda.invokeByRequest(slackARN, null, {"Subject": slackSub, "Message": slackMessage});
                    context.fail("Stage: Create lambda function code & configuration has failed");
                  }
                });
              });
            }
        });
    });
  });

  // good practice to catch this error explicitly
  archive.on('error', function(err) {
    console.log(err);
  });

  // pipe archive data to the file
  archive.pipe(output);

  // append a index.js from stream
  var index_file = exports.BUILD_DIR + "/" + process.env.PROJECT_NAME + '/' + 'index.js';
  archive.append(fs.createReadStream(index_file), { name: 'index.js' });

  // append node_modules
  var module_dir = exports.BUILD_DIR + "/" + process.env.PROJECT_NAME + "/" + "node_modules";
  archive.directory(module_dir,'node_modules');

  // finalize the archive (ie we are done appending files but streams have to finish yet)
  archive.finalize();
};
