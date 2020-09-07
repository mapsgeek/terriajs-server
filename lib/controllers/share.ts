/* jshint node: true, esnext: true */
"use strict";

var bodyParser = require("body-parser");
var requestp = require("request-promise");
var rperrors = require("request-promise/errors");

var gistAPI = "https://api.github.com/gists";

var prefixSeparator = "-"; // change the regex below if you change this
var splitPrefixRe = /^(([^-]+)-)?(.*)$/;

//You can test like this with httpie:
//echo '{ "test": "me" }' | http post localhost:3001/api/v1/share
function makeGist(serviceOptions: any, body: any) {
  var gistFile: any = {};
  gistFile[serviceOptions.gistFilename || "usercatalog.json"] = {
    content: body
  };

  var headers: any = {
    "User-Agent": serviceOptions.userAgent || "TerriaJS-Server",
    Accept: "application/vnd.github.v3+json"
  };
  if (serviceOptions.accessToken !== undefined) {
    headers["Authorization"] = "token " + serviceOptions.accessToken;
  }
  return requestp({
    url: gistAPI,
    method: "POST",
    headers: headers,
    json: true,
    body: {
      files: gistFile,
      description: serviceOptions.gistDescription || "User-created catalog",
      public: false
    },
    transform: function(body: any, response: any) {
      if (response.statusCode === 201) {
        console.log("Created ID " + response.body.id + " using Gist service");
        return response.body.id;
      } else {
        return response;
      }
    }
  });
}

// Test: http localhost:3001/api/v1/share/g-98e01625db07a78d23b42c3dbe08fe20
function resolveGist(serviceOptions: any, id: any) {
  var headers: any = {
    "User-Agent": serviceOptions.userAgent || "TerriaJS-Server",
    Accept: "application/vnd.github.v3+json"
  };
  if (serviceOptions.accessToken !== undefined) {
    headers["Authorization"] = "token " + serviceOptions.accessToken;
  }
  return requestp({
    url: gistAPI + "/" + id,
    headers: headers,
    json: true,
    transform: function(body: any, response: any) {
      if (response.statusCode >= 300) {
        return response;
      } else {
        return parseJson(body.files[Object.keys(body.files)[0]].content); // find the contents of the first file in the gist
      }
    }
  });
}
/*
  Generate short ID by hashing body, converting to base62 then truncating.
 */
function shortId(body: any, length: any) {
  var hmac = require("crypto")
    .createHmac("sha1", body)
    .digest();
  var base62 = require("base-x")(
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
  );
  var fullkey = base62.encode(hmac);
  return fullkey.slice(0, length); // if length undefined, return the whole thing
}

var _S3: any;

function S3(serviceOptions: any) {
  if (_S3) {
    return _S3;
  } else {
    var aws = require("aws-sdk");
    aws.config.setPromisesDependency(require("when").Promise);
    aws.config.update({
      region: serviceOptions.region
    });
    // if no credentials provided, we assume that they're being provided as environment variables or in a file
    if (serviceOptions.accessKeyId) {
      aws.config.update({
        accessKeyId: serviceOptions.accessKeyId,
        secretAccessKey: serviceOptions.secretAccessKey
      });
    }
    _S3 = new aws.S3();
    return _S3;
  }
}

// We append some pseudo-dir prefixes into the actual object ID to avoid thousands of objects in a single pseudo-directory.
// MyRaNdoMkey => M/y/MyRaNdoMkey
const idToObject = (id: any) => id.replace(/^(.)(.)/, "$1/$2/$1$2");

function saveS3(serviceOptions: any, body: any) {
  var id = shortId(body, serviceOptions.keyLength);
  const params = {
    Bucket: serviceOptions.bucket,
    Key: idToObject(id),
    Body: body
  };

  return S3(serviceOptions)
    .putObject(params)
    .promise()
    .then(function(result: any) {
      console.log(
        "Saved key " +
          id +
          " to S3 bucket " +
          params.Bucket +
          ":" +
          params.Key +
          ". Etag: " +
          result.ETag
      );
      return id;
    })
    .catch(function(e) {
      console.error(e);
      return e;
    });
}

function resolveS3(serviceOptions: any, id: any) {
  const params = {
    Bucket: serviceOptions.bucket,
    Key: idToObject(id)
  };
  return S3(serviceOptions)
    .getObject(params)
    .promise()
    .then(function(data: any) {
      return parseJson(data.Body);
    })
    .catch(function(e: any) {
      throw {
        response: e,
        error: e.message
      };
    });
}

function parseJson(catalogJson: any): CatalogResult {
  // Some check if v7
  // Convert

  return catalogJson;
}

export default function(hostName: string, port: number, options: any) {
  if (!options.shareUrlPrefixes) {
    return;
  }

  var router = require("express").Router();
  router.use(
    bodyParser.text({
      type: "*/*",
      limit: options.shareMaxRequestSize || "200kb"
    })
  );

  // Requested creation of a new short URL.
  router.post("/", function(req: any, res: any, next: any) {
    if (
      options.newShareUrlPrefix === undefined ||
      !options.shareUrlPrefixes[options.newShareUrlPrefix]
    ) {
      return res.status(404).json({
        message:
          "This server has not been confiddgured to generate new share URLs."
      });
    }
    var serviceOptions = options.shareUrlPrefixes[options.newShareUrlPrefix];
    var minter: any = {
      gist: makeGist,
      s3: saveS3
    }[serviceOptions.service.toLowerCase()];

    minter(serviceOptions, req.body)
      .then(function(id: any) {
        id = options.newShareUrlPrefix + prefixSeparator + id;
        var resPath = req.baseUrl + "/" + id;
        // these properties won't behave correctly unless "trustProxy: true" is set in user's options file.
        // they may not behave correctly (especially port) when behind multiple levels of proxy
        var resUrl =
          req.protocol +
          "://" +
          req.hostname +
          (req.header("X-Forwarded-Port") || port) +
          resPath;
        res
          .location(resUrl)
          .status(201)
          .json({ id: id, path: resPath, url: resUrl });
      })
      .catch(rperrors.TransformError, function(reason: any) {
        console.error(JSON.stringify(reason, null, 2));
        res.status(500).json({ message: reason.cause.message });
      })
      .catch(function(reason: any) {
        console.warn(JSON.stringify(reason, null, 2));
        res
          .status(500) // probably safest if we always return a consistent error code
          .json({ message: reason.error });
      });
  });

  // Resolve an existing ID. We break off the prefix and use it to work out which resolver to use.
  router.get("/:id", function(req: any, res: any, next: any) {
    var prefix = req.params.id.match(splitPrefixRe)[2] || "";
    var id = req.params.id.match(splitPrefixRe)[3];
    var resolver;

    var serviceOptions = options.shareUrlPrefixes[prefix];
    if (!serviceOptions) {
      console.error(
        'Share: Unknown prefix to resolve "' + prefix + '", id "' + id + '"'
      );
      return res.status(400).send('Unknown share prefix "' + prefix + '"');
    } else {
      resolver = {
        gist: resolveGist,
        s3: resolveS3
      }[serviceOptions.service.toLowerCase()];
    }
    resolver(serviceOptions, id)
      .then(function(content: any) {
        res.send(content);
      })
      .catch(rperrors.TransformError, function(reason: any) {
        console.error(JSON.stringify(reason, null, 2));
        res.status(500).send(reason.cause.message);
      })
      .catch(function(reason: any) {
        console.warn(JSON.stringify(reason.response, null, 2));
        res
          .status(404) // probably safest if we always return 404 rather than whatever the upstream provider sets.
          .send(reason.error);
      });
  });
  return router;
}
