#!/bin/bash

echo "Checking Raspberry Pi system requirements..."

# Check for audio devices
echo "Checking audio devices..."
arecord -l
aplay -l

# Check for required packages
echo "Checking required packages..."
for pkg in alsa-utils libasound2-dev; do
    if dpkg -l | grep -q $pkg; then
        echo "$pkg is installed"
    else
        echo "$pkg is missing. Install with: sudo apt-get install $pkg"
    fi
done

# Check Node.js version
echo "Checking Node.js version..."
node -v

# Check permissions
echo "Checking audio group membership..."
groups | grep -q audio && echo "User has audio group access" || echo "Add user to audio group with: sudo usermod -a -G audio $USER"

# Check ALSA configuration
echo "Checking ALSA configuration..."
cat /proc/asound/cards 