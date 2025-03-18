const express = require('express');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const { exec } = require('child_process');
const path = require('path');
const https = require('https');
require('dotenv').config();
const { personalities } = require('./personalities');
const os = require('os');

const app = express();
const port = 3000;

// Add HTTPS credentials
const credentials = {
    key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem'))
};

// Add these middleware configurations before your routes
app.use(express.json({limit: '50mb'}));
app.use(express.static('public'));

const FormData = require('form-data');

// Either local or remote
const COMPUTE_IP = process.env.REMOTE_DESKTOP_IP;

// Add these path constants near the top of the file
const AUDIO_DIR = path.join(__dirname, 'audio');
const UPLOADS_DIR = path.join(AUDIO_DIR, 'uploads');
const RESPONSES_DIR = path.join(AUDIO_DIR, 'responses');
const INITIAL_DIR = path.join(AUDIO_DIR, 'initial');

//Single or multiple personalities
const PERSONALITY_MODE = process.env.PERSONALITY_MODE || 'single';

// Add at the top with other env vars
const DEBUG = process.env.DEBUG === 'true';

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

// Update synthesizeSpeech to use personality-specific voice
async function synthesizeSpeech(text, outputPath, voiceId) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
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

// Add a central personality manager
const PersonalityManager = {
    // Tracked personalities
    activePersonalities: ['advisor', 'critic', 'supporter'],
    currentPersonalityIndex: 0,
    currentPersonality: null,

    //
    setPersonality(personalityId) {
      this.currentPersonality = personalities[personalityId];
    },

    // Get the next personality to respond (round-robin style)
    getNextPersonality() {
        const personalityId = this.activePersonalities[this.currentPersonalityIndex];
        this.currentPersonalityIndex = (this.currentPersonalityIndex + 1) % this.activePersonalities.length;
        return personalities[personalityId];
    },
    
    // Choose a specific personality
    getPersonality(id) {
        return personalities[id] || personalities['advisor']; // Default to advisor
    },
    
    // Get all personalities
    getAllPersonalities() {
        return this.activePersonalities.map(id => personalities[id]);
    }
};

// Update the query-llama endpoint to select the personality
app.post('/query-llama', async (req, res) => {
    const startTime = timeLog('Starting Llama query');
    try {
        const { transcription } = req.body;
        
        if (!transcription || transcription.trim() === '') {
            return res.json({ response: '' });
        }
        
        // Choose personality based on PERSONALITY_MODE
        let personality;
        if (process.env.PERSONALITY_MODE === 'multiple') {
            personality = PersonalityManager.getNextPersonality();
        } else {
            // If not multiple, use the current personality or default to advisor
            personality = PersonalityManager.currentPersonality || PersonalityManager.getPersonality('advisor');
        }
        const personalityId = personality.id;
        
        timeLog(`Selected personality: ${personality.name} (${personalityId})`);

        // Add to personality's pending transcriptions and check if it's already processing
        const isAlreadyProcessing = personality.addPendingTranscription(transcription);
        
        if (isAlreadyProcessing) {
            timeLog('Added to processing queue for ' + personalityId);
            return res.json({ queued: true, personalityId });
        }
        
        // Start processing
        personality.isProcessing = true;
        
        try {
            const fullTranscription = personality.getAndClearPendingTranscriptions();
            personality.updateHistory(fullTranscription);
            const fullPrompt = personality.getFullPrompt();
            
            const response = await queryLlama(fullPrompt);
            personality.updateHistory(response);
            
            timeLog('Llama query complete', startTime);
            res.json({ 
                response, 
                personalityId,
                position: personality.position, 
                voiceId: personality.voiceId
            });
        } finally {
            personality.isProcessing = false;
        }
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

// Modify process-text endpoint
app.post('/process-text', async (req, res) => {
    const startTime = timeLog('Starting text-only processing');
    try {
        const { text, personalityId = 'advisor' } = req.body;
        const personality = personalities[personalityId];

        if (!text) {
            throw new Error("No text received");
        }

        if (!personality) {
            throw new Error(`Unknown personality: ${personalityId}`);
        }

        timeLog(`Using personality: ${personality.name} with voice ID: ${personality.voiceId}`);

        if (DEBUG) {
            // In debug mode, always return initial_response.mp3
            const debugAudioPath = path.join(INITIAL_DIR, 'initial_response.mp3');
            timeLog('DEBUG MODE: Using initial_response.mp3');
            res.set('Content-Type', 'audio/mpeg');
            res.send(fs.readFileSync(debugAudioPath));
            return;
        }

        const audioFilePath = path.join(RESPONSES_DIR, `response_${personalityId}_${Date.now()}.mp3`);
        await synthesizeSpeech(text, audioFilePath, personality.voiceId);
        
        lastGeneratedAudio = audioFilePath;
        
        res.set('Content-Type', 'audio/mpeg');
        res.send(fs.readFileSync(audioFilePath));
        
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

// Add back the transcribe endpoint
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

// Add this function to get all available IP addresses
function getIpAddresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        }
    }
    
    return addresses;
}

// Update the server creation and listening
const httpsServer = https.createServer(credentials, app);

httpsServer.listen(port, '0.0.0.0', () => {
    initializeAudioDirectories();
    
    const addresses = getIpAddresses();
    timeLog(`Backend running at https://localhost:${port}`);
    
    if (addresses.length > 0) {
        addresses.forEach(ip => {
            timeLog(`Also available at https://${ip}:${port}`);
        });
    }
});

//create mobile-integration branch