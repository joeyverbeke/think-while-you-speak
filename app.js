const express = require('express');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const { exec } = require('child_process');
const path = require('path');
require('dotenv').config();

const app = express();
const port = 3000;

// Add these middleware configurations before your routes
app.use(express.json({limit: '50mb'}));
app.use(express.static('public'));

const conversationHistory = [];

const FormData = require('form-data');

// Add these constants near the top with others
const MAX_HISTORY_LENGTH = 10; // Keep last 5 exchanges
const MAX_TOTAL_CHARS = 2000; // Limit total character length of history

// Either local or remote
const COMPUTE_IP = process.env.REMOTE_DESKTOP_IP;

// Add these path constants near the top of the file
const AUDIO_DIR = path.join(__dirname, 'audio');
const UPLOADS_DIR = path.join(AUDIO_DIR, 'uploads');
const RESPONSES_DIR = path.join(AUDIO_DIR, 'responses');
const INITIAL_DIR = path.join(AUDIO_DIR, 'initial');

// Initialize the audio directories
function initializeAudioDirectories() {
    [AUDIO_DIR, UPLOADS_DIR, RESPONSES_DIR, INITIAL_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            timeLog(`Created directory: ${dir}`);
        }
    });
}

// Update lastGeneratedAudio path
let lastGeneratedAudio = path.join(INITIAL_DIR, 'initial_response.mp3');

// Add this utility function at the top of your file
function timeLog(message, startTime) {
    const elapsed = startTime ? ((Date.now() - startTime) / 1000).toFixed(2) : 0;
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${message}${startTime ? ` (${elapsed}s)` : ''}`);
    return Date.now();
}

// Add this near the top with other constants
const SYSTEM_PROMPT = `You are a voice agent that is guiding a user through a conversation they are having with someone else. Your responses are delivered to the user**while** they are talking. Your responses should be:
1. Very breif! 10 words or less.IMPORTANT: Keep you responses VERY brief, MAXIMUM 10 words
2. Provide critique and suggestions for what the user should say
3. Add in some divergent/absurdist responses, that still relate to the conversation
4. Remember that the user will likely interrupt you
5. Maintain context of the conversation

Current conversation:
`;

// Add this function to manage conversation history
function updateConversationHistory(newMessage) {
    conversationHistory.push(newMessage);
    
    // Trim history if it exceeds max length
    if (conversationHistory.length > MAX_HISTORY_LENGTH * 2) { // *2 because we have both user and system messages
        timeLog(`Trimming conversation history from ${conversationHistory.length} messages`);
        conversationHistory.splice(0, 2); // Remove oldest exchange (user message and system response)
    }

    // Also check total character length
    let totalLength = conversationHistory.join('\n').length;
    while (totalLength > MAX_TOTAL_CHARS && conversationHistory.length > 2) {
        timeLog(`Trimming conversation history from ${totalLength} characters`);
        conversationHistory.splice(0, 2);
        totalLength = conversationHistory.join('\n').length;
    }
}

// Update the transcribeAudio function
async function transcribeAudio(filePath) {
    const startTime = timeLog('Starting Whisper transcription...');
    const formData = new FormData();
    formData.append('file', fs.createReadStream(filePath));
    formData.append('model', 'whisper-1');

    try {
        const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            }
        });
        timeLog('Whisper transcription complete', startTime);
        return response.data.text;
    } catch (error) {
        timeLog('Whisper API Error');
        console.error(error.response?.data || error.message);
        throw new Error("Transcription failed");
    }
}

// Modify the queryLlama function to be simpler
async function queryLlama(prompt) {
    timeLog('Starting Llama query...');
    try {
        const response = await axios.post(`http://${COMPUTE_IP}:11434/api/generate`, {
            model: 'llama3.1:8b',
            prompt: prompt,
            stream: false
        });
        timeLog('Llama query completed');
        return response.data.response;
    } catch (error) {
        timeLog('Llama query error');
        console.error('Ollama API Error:', error.response?.data || error.message);
        throw error;
    }
}

// TTS via ElevenLabs
async function synthesizeSpeech(text, outputPath) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL_ID;

  const response = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    text,
    model_id: modelId,
  }, {
    headers: {
      'xi-api-key': apiKey,
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json'
    }, 
    responseType: 'arraybuffer'
  });

  fs.writeFileSync(outputPath, Buffer.from(response.data));
  return outputPath;
}

// Update the transcribe endpoint
app.post('/transcribe', async (req, res) => {
    const startTime = timeLog('Starting transcription request');
    try {
        if (!req.body || !req.body.audio) {
            throw new Error("No audio data received");
        }

        // Create temporary file in uploads directory
        const audioBuffer = Buffer.from(req.body.audio, 'base64');
        const audioFilePath = path.join(UPLOADS_DIR, `audio_${Date.now()}.wav`);
        fs.writeFileSync(audioFilePath, audioBuffer);

        // Transcribe
        const transcription = await transcribeAudio(audioFilePath);
        timeLog(`Transcription result: "${transcription}"`);
        
        // Cleanup
        fs.unlinkSync(audioFilePath);
        
        res.json({ transcription });
    } catch (error) {
        timeLog('Error in transcription');
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Update the query-llama endpoint to handle empty transcriptions
app.post('/query-llama', async (req, res) => {
    const startTime = timeLog('Starting Llama query');
    try {
        if (!req.body || !req.body.transcription) {
            timeLog('Empty or missing transcription received');
            return res.status(400).json({ error: "No transcription received" });
        }

        if (req.body.transcription.trim() === '') {
            timeLog('Empty transcription, skipping processing');
            return res.json({ response: '' });
        }

        // Add transcription to conversation history with length management
        updateConversationHistory(req.body.transcription);
        
        // Create full prompt with system prompt and conversation
        const fullPrompt = SYSTEM_PROMPT + conversationHistory.join("\n");
        const response = await queryLlama(fullPrompt);
        
        // Add system's response to history
        updateConversationHistory(response);
        
        timeLog('Llama query complete', startTime);
        res.json({ response });
    } catch (error) {
        timeLog('Error in Llama query');
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Serve last generated audio for immediate playback
app.get('/last-audio', (req, res) => {
  if (fs.existsSync(lastGeneratedAudio)) {
    res.set('Content-Type', 'audio/mpeg');
    res.send(fs.readFileSync(lastGeneratedAudio));
  } else {
    res.status(404).send("No audio available yet.");
  }
});

// Update the process-text endpoint
app.post('/process-text', async (req, res) => {
    const startTime = timeLog('Starting text-only processing');
    try {
        if (!req.body || !req.body.text) {
            throw new Error("No text received");
        }

        // Generate speech from text
        const audioFilePath = path.join(RESPONSES_DIR, `response_${Date.now()}.mp3`);
        await synthesizeSpeech(req.body.text, audioFilePath);
        
        // Update last generated audio path
        lastGeneratedAudio = audioFilePath;
        
        // Send audio file
        res.set('Content-Type', 'audio/mpeg');
        res.send(fs.readFileSync(audioFilePath));
        
        // Clean up old files (keep last 5 responses)
        cleanupOldResponses();
    } catch (error) {
        timeLog('Error in text processing');
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Add cleanup function for old response files
function cleanupOldResponses() {
    try {
        const files = fs.readdirSync(RESPONSES_DIR)
            .map(file => path.join(RESPONSES_DIR, file))
            .filter(file => file !== lastGeneratedAudio)
            .sort((a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime());

        // Keep only the 5 most recent files
        const filesToDelete = files.slice(4);
        filesToDelete.forEach(file => {
            fs.unlinkSync(file);
            timeLog(`Cleaned up old response file: ${file}`);
        });
    } catch (error) {
        timeLog('Error cleaning up old responses');
        console.error(error);
    }
}

// Initialize directories when the server starts
app.listen(port, () => {
    initializeAudioDirectories();
    console.log(`Backend running at http://localhost:${port}`);
});
