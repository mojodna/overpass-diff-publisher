# Overpass Diff Publisher

This uses Overpass to generate augmented diffs and publishes them to S3 for use
by OSMesa streaming APIs.

To get the replication timestamp from a source file:

```bash
aws s3 cp s3://osm-pds/2018/planet-180409.osm.pbf - | osmium fileinfo -F pbf -
```

That timestamp can then be used as an argument to the diff publisher. If omitted, it will start where it left off, according to `state.yaml` in the target path.

```bash
node index.js -t 2018-04-09T02:00:01Z s3://bucket/augdiffs/
```
