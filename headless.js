const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const Porcupine = require('@picovoice/porcupine-node');
const recorder = require('node-record-lpcm16');
const Speaker = require('speaker');
const { timeLog } = require('./utils');
const { personalities } = require('./personalities');

// Audio directories (same as in app.js)
const AUDIO_DIR = path.join(__dirname, 'audio');
const UPLOADS_DIR = path.join(AUDIO_DIR, 'uploads');
const RESPONSES_DIR = path.join(AUDIO_DIR, 'responses');
const INITIAL_DIR = path.join(AUDIO_DIR, 'initial');

// Track current state
let isListening = false;
let isProcessing = false;
let audioQueue = [];
let currentAudioProcess = null;

// Initialize the VAD system using Porcupine for wake word detection
// and record audio when speech is detected
async function initializeVAD() {
    try {
        // Configure recorder
        const recordingConfig = {
            sampleRate: 16000,
            channels: 1,
            audioType: 'wav',
            threshold: 0.5,
            silence: '1.0'
        };

        // Start listening for audio
        timeLog('Starting audio recording');
        const recording = recorder.record(recordingConfig);

        recording.stream()
            .on('data', async (data) => {
                // Here we'll implement a simple energy-based VAD
                // Calculate audio energy/volume
                const volume = calculateAudioVolume(data);
                
                // If volume exceeds threshold and we're not already listening
                if (volume > recordingConfig.threshold && !isListening) {
                    isListening = true;
                    timeLog('Speech detected');
                    
                    // Start capturing audio for transcription
                    const audioData = [];
                    
                    // Set up a timeout to stop recording after silence
                    const silenceTimeout = setTimeout(() => {
                        isListening = false;
                        
                        // Process the captured audio
                        const audioBuffer = Buffer.concat(audioData);
                        processAudioData(audioBuffer);
                        
                        audioData.length = 0; // Clear audio data
                    }, parseFloat(recordingConfig.silence) * 1000);
                    
                    // Capture data while listening
                    recording.stream().on('data', (chunk) => {
                        if (isListening) {
                            audioData.push(chunk);
                            
                            // Reset silence timeout on new data
                            clearTimeout(silenceTimeout);
                            silenceTimeout = setTimeout(() => {
                                isListening = false;
                                
                                // Process the captured audio
                                const audioBuffer = Buffer.concat(audioData);
                                processAudioData(audioBuffer);
                                
                                audioData.length = 0; // Clear audio data
                            }, parseFloat(recordingConfig.silence) * 1000);
                        }
                    });
                }
            })
            .on('error', (err) => {
                timeLog(`Recording error: ${err.message}`);
            });

        timeLog('VAD initialized');
    } catch (error) {
        timeLog(`Error initializing VAD: ${error.message}`);
        console.error(error);
    }
}

// Calculate audio volume (simple RMS)
function calculateAudioVolume(buffer) {
    // Convert buffer to 16-bit samples
    const samples = new Int16Array(buffer.buffer);
    
    // Calculate RMS
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        sum += Math.pow(samples[i], 2);
    }
    const rms = Math.sqrt(sum / samples.length);
    
    // Normalize to 0-1 range
    return rms / 32767;
}

// Process captured audio
async function processAudioData(audioBuffer) {
    try {
        // Save buffer to temp file
        const audioFilePath = path.join(UPLOADS_DIR, `audio_${Date.now()}.wav`);
        fs.writeFileSync(audioFilePath, audioBuffer);
        
        // Transcribe using existing backend function
        const transcription = await transcribeAudio(audioFilePath);
        
        // Clean up file
        fs.unlinkSync(audioFilePath);
        
        if (transcription.trim()) {
            timeLog(`Transcribed: "${transcription}"`);
            
            // Process the transcription
            if (!isProcessing) {
                isProcessing = true;
                await processUserSpeech(transcription);
                isProcessing = false;
                
                // Play any queued audio
                if (audioQueue.length > 0) {
                    playNextAudio();
                }
            }
        }
    } catch (error) {
        timeLog(`Error processing audio: ${error.message}`);
        console.error(error);
    }
}

// Play audio using system player
function playAudio(audioData) {
    return new Promise((resolve, reject) => {
        try {
            // Use aplay for Linux/Raspberry Pi
            const player = spawn('aplay', [audioData.path]);
            
            currentAudioProcess = player;
            
            player.on('close', (code) => {
                currentAudioProcess = null;
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Audio playback failed with code ${code}`));
                }
                
                // Clean up if needed
                if (audioData.cleanup) {
                    fs.unlinkSync(audioData.path);
                }
            });
            
            player.on('error', (err) => {
                currentAudioProcess = null;
                reject(err);
            });
        } catch (error) {
            currentAudioProcess = null;
            reject(error);
        }
    });
}

// Process user speech and get LLM response (adapted from processUserSpeech in main.js)
async function processUserSpeech(transcription) {
    // Reuse existing backend calls
    try {
        // Send to backend for LLama processing
        const response = await axios.post('http://localhost:3000/query-llama', {
            transcription
        });
        
        const { response: llamaResult, personalityId, position } = response.data;
        
        // Get audio for the response
        const audioResponse = await axios.post('http://localhost:3000/process-text', {
            text: llamaResult,
            personalityId
        }, {
            responseType: 'arraybuffer'
        });
        
        // Save audio to file
        const audioFilePath = path.join(RESPONSES_DIR, `response_${personalityId}_${Date.now()}.wav`);
        fs.writeFileSync(audioFilePath, Buffer.from(audioResponse.data));
        
        // Add to queue with position information
        audioQueue.push({
            path: audioFilePath,
            voiceId: personalityId,
            position: position,
            cleanup: true
        });
        
        // If not currently playing anything, start playback
        if (!currentAudioProcess) {
            playNextAudio();
        }
        
        return true;
    } catch (error) {
        timeLog(`Error processing speech: ${error.message}`);
        console.error(error);
        return false;
    }
}

// Play next audio in queue
async function playNextAudio() {
    if (audioQueue.length > 0 && !currentAudioProcess) {
        const audioData = audioQueue.shift();
        try {
            await playAudio(audioData);
            
            // Continue with next audio if available
            playNextAudio();
        } catch (error) {
            timeLog(`Error playing audio: ${error.message}`);
            console.error(error);
            
            // Try next audio
            playNextAudio();
        }
    }
}

// Initialize and start the headless system
async function startHeadless() {
    try {
        timeLog('Starting headless system');
        
        // Initialize audio directories
        [AUDIO_DIR, UPLOADS_DIR, RESPONSES_DIR, INITIAL_DIR].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
        
        // Initialize audio recording and VAD
        await initializeVAD();
        
        // If we have an initial response, queue it
        const initialFilePath = path.join(INITIAL_DIR, 'initial_response.wav');
        if (fs.existsSync(initialFilePath)) {
            audioQueue.push({
                path: initialFilePath,
                voiceId: 'advisor',
                position: { x: 0, y: 0, z: 1 },
                cleanup: false
            });
            
            // Start playing
            playNextAudio();
        }
        
        timeLog('Headless system started and ready');
    } catch (error) {
        timeLog(`Error starting headless system: ${error.message}`);
        console.error(error);
    }
}

// Export the functions
module.exports = {
    startHeadless,
    stopHeadless: () => {
        // Stop any current playback
        if (currentAudioProcess) {
            currentAudioProcess.kill();
            currentAudioProcess = null;
        }
        
        // Stop recording
        recorder.stop();
        
        timeLog('Headless system stopped');
    }
}; 