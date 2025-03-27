#!/bin/bash

echo "Installing dependencies..."
sudo apt-get update
sudo apt-get install -y alsa-utils libasound2-dev

echo "Installing Node.js dependencies..."
npm install node-record-lpcm16 speaker @picovoice/porcupine-node

echo "Setting up systemd service..."
sudo cp conversation-engine.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable conversation-engine

echo "Testing audio devices..."
arecord -l
aplay -l

echo "Setup complete. To start the service, run:"
echo "sudo systemctl start conversation-engine"
echo "To view logs, run:"
echo "sudo journalctl -u conversation-engine -f" 