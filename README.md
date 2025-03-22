# Think While You Speak

An AI voice agent that responds to users **while** they are talking.

## Features

- Voice Activity Detection (VAD) for real-time speech detection
- Real-time audio processing and response generation
- Interrupting playback that only plays while the user is speaking
- Multi-model pipeline:
  - Whisper API for speech-to-text
  - Llama for response generation
  - ElevenLabs for text-to-speech

## Setup

1. Clone the repository
    ```bash
    git clone [repository-url]
    cd think-while-you-speak
    ```

2. Install dependencies
    ```bash
    npm i
    ```

3. Create a `.env` file with your API keys:
    ```bash
    ELEVENLABS_API_KEY="your-elevenlabs-key"
    ELEVENLABS_VOICE_ID="your-voice-id"
    ELEVENLABS_MODEL_ID="eleven_turbo_v2_5"
    OPENAI_API_KEY="your-openai-key"
    REMOTE_DESKTOP_IP="your-remote-ip"    # If using remote compute
    LOCAL_DESKTOP_IP="127.0.0.1"
    ```

4. Start Ollama with the Llama model
    ```bash
    ollama serve
    ```

5. Start the server
    ```bash
    nodemon app.js
    ```

6. Open `http://localhost:3000` in your browser

## Project Structure
```
project_root/
├── audio/
│   ├── uploads/    # Temporary WAV files
│   ├── responses/  # Generated MP3 responses
│   └── initial/    # Initial/default responses
├── public/
│   ├── index.html  # Frontend interface
│   └── js/
│       └── main.js # Frontend logic
└── app.js         # Backend server
```

## How It Works

1. The frontend uses VAD to detect when the user starts speaking
2. When speech is detected:
   - If there's a queued response, it starts playing
   - If not, it plays the most recent response
3. When speech ends:
   - The audio is sent to Whisper for transcription
   - The transcription is sent to Llama for processing
   - Llama's response is sent to ElevenLabs for voice synthesis
   - The generated audio is queued for the next speech detection

## Dependencies

- Express.js for the backend server
- @ricky0123/vad-web for Voice Activity Detection
- Ollama for running the Llama model
- OpenAI's Whisper API for transcription
- ElevenLabs API for text-to-speech

## Raspberry Pi Setup

1. Install required packages:
    ```bash
    sudo apt-get update
    sudo apt-get install alsa-utils libasound2-dev
    ```

2. Add your user to the audio group:
    ```bash
    sudo usermod -a -G audio $USER
    ```

3. Check audio configuration:
    ```bash
    # List audio devices
    arecord -l
    aplay -l
    ```

4. Run the compatibility check:
    ```bash
    chmod +x check-pi-requirements.sh
    ./check-pi-requirements.sh
    ```

5. If using Chromium, enable the following flags:
    - Navigate to chrome://flags
    - Enable "Override software rendering list"
    - Enable "WebRTC PipeWire support"