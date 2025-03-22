function timeLog(message, startTime) {
    const elapsed = startTime ? ((Date.now() - startTime) / 1000).toFixed(2) : 0;
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${message}${startTime ? ` (${elapsed}s)` : ''}`);
    return Date.now();
}

let vadInstance;
let audioQueue = []; // Queue of audio data objects
let currentAudioData = null; // Track current audio data including position
let currentAudioElement = null;
let isCurrentlySpeaking = false;
let currentAudioBlob = null; // Keep track of the current audio blob
let currentPlaybackTime = 0; // Track current playback position
let isProcessing = false; // Flag to track if we're processing a response
let pendingTranscriptions = []; // Store transcriptions while processing
let processingPromise = null; // Store the current processing promise
let audioContext;
let pannerNodes = new Map(); // Store panner nodes for each voice
let isFirstSpeech = true;

// Add Raspberry Pi detection
const isRaspberryPi = navigator.userAgent.toLowerCase().includes('linux armv');

// Update VAD initialization
async function initializeVAD() {
    const startTime = timeLog('Initializing VAD...');
    
    try {
        // Configure for Raspberry Pi
        const vadConfig = {
            model: 'legacy',
            positiveSpeechThreshold: isRaspberryPi ? 0.6 : 0.5,
            negativeSpeechThreshold: isRaspberryPi ? 0.45 : 0.35,
            minSpeechFrames: isRaspberryPi ? 5 : 3,
            preSpeechPadFrames: 5,
            // Specific audio constraints for Raspberry Pi
            audioConstraints: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 16000
            }
        };

        // Log device info
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        timeLog('Available audio inputs:', audioInputs.map(d => d.label));

        // Initialize VAD with logging
        timeLog('Creating VAD with config:', vadConfig);
        vadInstance = await vad.MicVAD.new(vadConfig);

        // Add error handlers
        vadInstance.onerror = (error) => {
            console.error('VAD error:', error);
            timeLog('VAD error occurred');
        };

        // Start VAD with explicit error handling
        await vadInstance.start().catch(error => {
            console.error('Error starting VAD:', error);
            throw error;
        });

        timeLog('VAD initialization complete', startTime);
    } catch (error) {
        console.error("Error initializing VAD:", error);
        console.error("Detailed error:", error.message);
        if (error.stack) console.error("Stack trace:", error.stack);
        throw error;
    }
}

// Update audio context initialization
async function initializeAudioContext() {
    try {
        if (!audioContext) {
            const contextOptions = {
                // Lower sample rate for better performance on Pi
                sampleRate: isRaspberryPi ? 16000 : 44100,
                latencyHint: isRaspberryPi ? 'playback' : 'interactive'
            };
            audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
        }
        
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        // Test audio system
        const testOsc = audioContext.createOscillator();
        const testGain = audioContext.createGain();
        testGain.gain.value = 0; // Silent test
        testOsc.connect(testGain);
        testGain.connect(audioContext.destination);
        testOsc.start();
        testOsc.stop(audioContext.currentTime + 0.1);

        timeLog('Audio context initialized');
    } catch (error) {
        console.error('Audio initialization error:', error);
        throw error;
    }
}

// Add function to get or create panner for a personality
function getPersonalityPanner(personalityId, position) {
    if (!pannerNodes.has(personalityId)) {
        const panner = audioContext.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        
        // Set position from backend
        panner.positionX.value = position.x;
        panner.positionY.value = position.y;
        panner.positionZ.value = position.z;
        
        panner.connect(audioContext.destination);
        pannerNodes.set(personalityId, panner);
        timeLog(`Created new panner for ${personalityId} at position (${position.x}, ${position.y}, ${position.z})`);
    }
    return pannerNodes.get(personalityId);
}

async function playAudio(data) {
    if (!data || !data.blob) {
        console.error('Invalid audio data received');
        return;
    }

    const { blob, voiceId: personalityId, position, timestamp } = data;
    if (!position) {
        console.error('No position data for personality:', personalityId);
        return;
    }

    const startTime = timeLog(`Starting audio playback for personality ${personalityId}...`);
    
    if (!audioContext) {
        initializeAudioContext();
    }
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    // Store current audio data with timestamp
    currentAudioData = {
        ...data,
        timestamp: timestamp || Date.now()
    };

    // Get or create panner for this personality
    const panner = getPersonalityPanner(personalityId, position);

    if (currentAudioElement) {
        try {
            currentAudioElement.stop();
        } catch (error) {
            console.error('Error stopping previous audio:', error);
        }
        currentAudioElement = null;
    }

    // Reset playback time for new audio
    if (currentAudioData !== data) {
        currentPlaybackTime = 0;
    }

    try {
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(panner);
        
        source.onended = () => {
            timeLog('Audio playback ended');
            if (isCurrentlySpeaking && audioQueue.length > 0) {
                timeLog('Playing next queued audio');
                currentPlaybackTime = 0;
                playAudio(audioQueue.shift());
            }
        };

        if (isCurrentlySpeaking) {
            source.start(0, currentPlaybackTime);
            timeLog('Audio playback started', startTime);
        }

        currentAudioElement = source;
    } catch (error) {
        console.error(`Error playing spatial audio for personality ${personalityId}:`, error);
    }
}

async function fetchLastAudio() {
    const startTime = timeLog('Fetching last audio...');
    const response = await fetch('/last-audio');
    if (response.ok) {
        timeLog('Successfully fetched last audio', startTime);
        return await response.blob();
    }
    timeLog('No audio available', startTime);
    return null;
}

async function processUserSpeech(transcription) {
    const startTime = timeLog('Starting end-to-end processing');
    try {
        // Send to backend without specifying personality
        timeLog('Sending to Llama...');
        const llamaResponse = await fetch('/query-llama', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ transcription })
        });

        if (!llamaResponse.ok) {
            throw new Error(`Llama query failed with ${llamaResponse.status}`);
        }

        const responseData = await llamaResponse.json();
        
        if (responseData.queued) {
            timeLog(`Transcription queued for later processing`);
            return true;
        }

        const { response: llamaResult, personalityId, position } = responseData;
        
        timeLog(`Generating speech for ${personalityId}...`);
        const response = await fetch('/process-text', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                text: llamaResult,
                personalityId
            })
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
        }

        const audioBlob = await response.blob();
        // Add timestamp when adding to queue
        audioQueue.push({ 
            blob: audioBlob, 
            voiceId: personalityId,
            position: position,
            timestamp: Date.now()
        });
        timeLog('Full end-to-end processing complete', startTime);
        
        return true;
    } catch (error) {
        console.error("Error in end-to-end processing:", error);
        return false;
    }
}

// Add more robust error handling to the start button
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('startBtn').onclick = async () => {
        try {
            // Request microphone access with explicit error handling
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1,
                    sampleRate: 16000
                }
            });
            
            timeLog('Microphone access granted');
            
            // Test the audio stream
            const track = stream.getAudioTracks()[0];
            const capabilities = track.getCapabilities();
            timeLog('Audio capabilities:', capabilities);
            
            // Initialize audio context
            await initializeAudioContext();
            
            // Initialize VAD
            await initializeVAD();
            
            // Update UI
            document.getElementById('startBtn').disabled = true;
            document.getElementById('stopBtn').disabled = false;
            
        } catch (error) {
            console.error('Error starting application:', error);
            timeLog('Failed to start: ' + error.message);
            // Show error to user
            alert('Failed to start: ' + error.message);
        }
    };
    
    document.getElementById('stopBtn').onclick = () => {
        if (vadInstance) {
            vadInstance.pause();
            console.log("Listening stopped.");
        }
    };
}); 