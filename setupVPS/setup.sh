#!/bin/bash

mkdir -p osrm-data
cd osrm-data

# download map indo
wget http://download.geofabrik.de/asia/indonesia-latest.osm.pbf

# extract map
docker run -t -v $(pwd):/data osrm/osrm-backend osrm-extract -p /opt/car.lua /data/indonesia-latest.osm.pbf

# contract map
docker run -t -v $(pwd):/data osrm/osrm-backend osrm-contract /data/indonesia-latest.osrm

echo "Done."