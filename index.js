#!/usr/bin/env node
require("epipebomb")();
require("babel-polyfill");
require("core-js/features/array/flat");

const path = require("path");
const { Transform } = require("stream");
const url = require("url");
const { promisify } = require("util");
const zlib = require("zlib");

const _ = require("highland");
const AWS = require("aws-sdk");
const commandLineArgs = require("command-line-args");
const fs = require("fs-extra");
const YAML = require("yaml");

const gzip = promisify(zlib.gzip);

const {
  parsers: { AugmentedDiffParser },
  sources: { AugmentedDiffs }
} = require("osm-replication-streams");

process.on("unhandledRejection", err => {
  console.error(err.stack);
  process.exit(1);
});

const S3 = new AWS.S3();

const optionDefinitions = [
  {
    name: "initial-sequence",
    alias: "i",
    type: Number
  },
  { name: "timestamp", alias: "t", type: String },
  { name: "help", alias: "h", type: Boolean },
  { name: "target", defaultOption: true }
];

const options = commandLineArgs(optionDefinitions, { camelCase: true });

if (options.help) {
  console.warn(
    "Usage: overpass-diff-publisher [-i initial sequence] [-t timestamp] [target URI]"
  );
  process.exit(1);
}

const sequenceToTimestamp = sequence =>
  new Date((sequence * 60 + 1347432900) * 1000);

const timestampToSequence = timestamp =>
  Math.ceil((Date.parse(timestamp) / 1000 - 1347432900) / 60);

const getCurrentSequence = async u => {
  const uri = url.parse(u);

  switch (uri.protocol) {
    case "file:":
      const prefix = uri.host + uri.path;
      const state = YAML.parse(
        (await promisify(fs.readFile)(
          path.resolve(prefix, "state.yaml")
        )).toString()
      );
      return state.sequence + 1;

    case "s3:":
      const obj = await S3.getObject({
        Bucket: uri.host,
        Key: uri.path.slice(1) + "state.yaml"
      }).promise();

      return YAML.parse(obj.Body.toString()).sequence + 1;

    default:
      throw new Error(`Unsupported protocol: ${uri.protocol}`);
  }
};

/**
 * Consumes GeoJSON FeatureCollection representations of elements within
 * augmented diffs and updates the visible property based on the action
 * that produced them.
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
}

async function main() {
  const targetURI = options.target || "file://./";
  let initialSequence;

  if (options.initialSequence) {
    initialSequence = options.initialSequence;
  } else if (options.timestamp) {
    initialSequence = timestampToSequence(options.timestamp);
  } else {
    initialSequence = await getCurrentSequence(targetURI);
  }

  const writer = targetURI => async ([sequence, batch], callback) => {
    console.log(
      `${sequence} (${sequenceToTimestamp(sequence).toISOString()}): ${
        batch.length
      }`
    );

    const uri = url.parse(targetURI);
    const body = batch.map(x => `${JSON.stringify(x)}\n`).join("");
    const state = YAML.stringify({
      last_run: new Date().toISOString(),
      sequence
    });

    const s = sequence.toString().padStart(9, 0);
    const sequencePath = `${s.slice(0, 3)}/${s.slice(3, 6)}/${s.slice(6, 9)}`;

    switch (uri.protocol) {
      case "s3:":
        try {
          await S3.putObject({
            Body: await gzip(body),
            Bucket: uri.host,
            Key: uri.path.slice(1) + `${sequencePath}.json.gz`,
            ContentEncoding: "gzip",
            ContentType: "application/json"
          }).promise();

          await S3.putObject({
            Body: state,
            Bucket: uri.host,
            Key: uri.path.slice(1) + "state.yaml",
            ContentType: "application/vnd.yaml"
          }).promise();
        } catch (err) {
          return callback(err);
        }

        return callback();

      case "file:":
        const prefix = uri.host + uri.path;

        try {
          await fs.mkdirs(path.resolve(prefix, path.dirname(sequencePath)));
          await fs.writeFile(
            path.resolve(prefix, `${sequencePath}.json.gz`),
            await gzip(body)
          );
          await fs.writeFile(path.resolve(prefix, "state.yaml"), state);
        } catch (err) {
          return callback(err);
        }

        return callback();

      default:
        return callback(new Error(`Unsupported protocol: ${uri.protocol}`));
    }
  };

  const processor = new AugmentedDiffParser().on("error", console.warn);
  const extractor = new ExtractionStream();

  return new Promise((resolve, reject) => {
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
      .errors(reject)
      .done(resolve);
  });
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err.stack);
    process.exit(1);
  });
