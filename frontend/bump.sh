#!/bin/sh
# Setzt die Cache-Version in index.html auf den aktuellen Commit
v=$(git rev-parse --short HEAD)
sed -i '' -E "s/(main\\.(js|css))\\?v=[^\"]*/\\1?v=$v/g" index.html login.html
echo "Cache-Version: $v"
