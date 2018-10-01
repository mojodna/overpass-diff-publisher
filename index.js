#!/usr/bin/env node
require("epipebomb")();
require("babel-polyfill");

const fs = require("fs");
const path = require("path");
const { Transform } = require("stream");
const url = require("url");
const { promisify } = require("util");

const _ = require("highland");
const AWS = require("aws-sdk");
const YAML = require("yaml").default

const writeFileAsync = promisify(fs.writeFile);

const {
  parsers: { AugmentedDiffParser },
  sources: { AugmentedDiffs }
} = require("osm-replication-streams");

process.on("unhandledRejection", err => {
  console.error(err.stack);
  process.exit(1);
});

const ARGV = process.argv.slice(2);
const S3 = new AWS.S3();

if (ARGV.length === 0) {
  console.warn("Usage: overpass-diff-publisher <initial sequence | timestamp> [target URI]");
  process.exit(1);
}

const sequenceToTimestamp = sequence =>
  new Date((sequence * 60 + 1347432900) * 1000);

const timestampToSequence = timestamp =>
  Math.ceil(((Date.parse(timestamp) / 1000) - 1347432900) / 60);

const initialSequence = ARGV[0].match(/^\d+$/) ? ARGV[0] : timestampToSequence(ARGV[0]);
const targetURI = ARGV[1] || "file://./";

/**
 * Consumes GeoJSON FeatureCollection representations of elements within
 * augmented diffs and outputs only the new versions.
 */
class ExtractionStream extends Transform {
  constructor() {
    super({
      objectMode: true
    });
  }

  _transform(obj, _, callback) {
    if (obj.type === "Marker") {
      this.push(obj);
      return callback();
    }

    // fetch the replacement feature
    const feature = obj.features.find(f => f.id === "new");
    // set visibility based on the operation
    feature.properties.visible = obj.id !== "delete";

    this.push(obj);

    return callback();
  }
};

const writer = targetURI =>
  async ([sequence, batch], callback) => {
    console.log(`${sequence} (${sequenceToTimestamp(sequence).toISOString()}): ${batch.length}`);

    const uri = url.parse(targetURI);
    const body = batch
      .map(x => `${JSON.stringify(x)}\n`)
      .join("");
    const state = YAML.stringify({
      last_run: new Date().toISOString(),
      sequence
    })

    switch (uri.protocol) {
      case "s3:":
        try {
          await S3.putObject({
            Body: body,
            Bucket: uri.host,
            Key: uri.path.slice(1) + `${sequence}.json`
          }).promise();

          await S3.putObject({
            Body: state,
            Bucket: uri.host,
            Key: uri.path.slice(1) + "state.yaml"
          }).promise();
        } catch (err) {
          return callback(err);
        }

        return callback();

      case "file:":
        const prefix = uri.host + uri.path;

        try {
          await writeFileAsync(path.resolve(prefix, `${sequence}.json`), body);

          await writeFileAsync(path.resolve(prefix, "state.yaml"), state);
        } catch (err) {
          return callback(err);
        }

        return callback();

      default:
        return callback(new Error(`Unsupported protocol: ${uri.protocol}`));
    }
  }

const processor = new AugmentedDiffParser()
  .on("error", console.warn);

const extractor = new ExtractionStream();

_(
  AugmentedDiffs({
    baseURL: process.env.OVERPASS_URL,
    infinite: true,
    initialSequence
  })
    .pipe(processor)
    .pipe(extractor)
)
  // batch by sequence
  .through(s => {
    let batched = [];
    let sequence = null;

    return s.consume((err, x, push, next) => {
      if (err) {
        push(err);
        return next();
      }

      if (x === _.nil) {
        // end of the stream; flush
        if (batched.length > 0) {
          push(null, [sequence, batched]);
        }

        return push(null, _.nil);
      }

      if (x.type === "Marker") {
        if (x.properties.status === "start") {
          sequence = Number(x.properties.sequenceNumber);
        }

        if (x.properties.status === "end") {
          // new sequence; flush previous
          if (batched.length > 0) {
            push(null, [sequence, batched]);
          }

          // reset batch
          batched = [];
        }
      } else {
        // add this item to the batch
        batched.push(x);
      }

      return next();
    });
  })
  .flatMap(_.wrapCallback(writer(targetURI)))
  .errors(err => console.warn(err.stack))
  .done(() => console.log("Done"));
