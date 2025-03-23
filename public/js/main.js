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
        // Get audio devices first
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        
        audioInputs.forEach(device => {
            timeLog(`Found audio input: ${device.label || 'Unnamed Device'} (${device.deviceId})`);
        });

        // Get default audio input
        const defaultInput = audioInputs.find(d => d.deviceId === 'default') || audioInputs[0];
        if (!defaultInput) {
            throw new Error('No audio input devices found');
        }
        timeLog(`Using audio input: ${defaultInput.label || 'Default Device'}`);

        // Configure VAD
        const vadConfig = {
            model: 'legacy',
            positiveSpeechThreshold: 0.7,
            negativeSpeechThreshold: 0.4,
            minSpeechFrames: 4,
            preSpeechPadFrames: 5,
            audioConstraints: {
                deviceId: defaultInput.deviceId,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 1,
                sampleRate: 16000
            },
            onSpeechStart: async () => {
                timeLog('Speech detected');
                isCurrentlySpeaking = true;

                if (isFirstSpeech) {
                    timeLog('Playing initial response');
                    const initialResponse = await fetch('/last-audio');
                    if (initialResponse.ok) {
                        const blob = await initialResponse.blob();
                        playAudio({
                            blob,
                            voiceId: 'advisor',
                            position: { x: 0, y: 0, z: 1 }
                        });
                    }
                    isFirstSpeech = false;
                } else if (audioQueue.length > 0) {
                    timeLog('Playing queued audio');
                    currentAudioData = null;
                    playAudio(audioQueue.shift());
                } else if (currentAudioData) {
                    timeLog('Resuming current audio');
                    playAudio(currentAudioData);
                }
            },
            onSpeechEnd: async (audio) => {
                timeLog('Speech ended');
                isCurrentlySpeaking = false;

                if (currentAudioElement) {
                    currentAudioElement.stop();
                    currentAudioElement = null;
                }

                try {
                    const wavBuffer = vad.utils.encodeWAV(audio);
                    const base64Audio = vad.utils.arrayBufferToBase64(wavBuffer);
                    
                    timeLog('Sending audio for transcription...');
                    const response = await fetch('/transcribe', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ audio: base64Audio })
                    });

                    if (!response.ok) {
                        throw new Error(`Transcription failed: ${response.status}`);
                    }

                    const { transcription } = await response.json();
                    timeLog(`Transcribed: "${transcription}"`);

                    if (!isProcessing && transcription.trim()) {
                        isProcessing = true;
                        await processUserSpeech(transcription);
                        isProcessing = false;
                    }
                } catch (error) {
                    console.error("Error processing speech:", error);
                    timeLog(`Error: ${error.message}`);
                }
            }
        };

        timeLog('Creating VAD instance...');
        vadInstance = await vad.MicVAD.new(vadConfig);
        timeLog('Starting VAD...');
        await vadInstance.start();
        
        document.getElementById('startBtn').disabled = true;
        document.getElementById('stopBtn').disabled = false;
        
        timeLog('VAD initialization complete', startTime);
    } catch (error) {
        console.error("Error initializing VAD:", error);
        timeLog(`VAD Error: ${error.message}`);
        throw error;
    }
}

// Update audio context initialization with correct sample rate
async function initializeAudioContext() {
    try {
        if (!audioContext) {
            const contextOptions = {
                sampleRate: 44100,           // Standard CD-quality sample rate
                latencyHint: 'interactive'
            };
            audioContext = new (window.AudioContext || window.webkitAudioContext)(contextOptions);
            timeLog(`Audio context created with sample rate: ${audioContext.sampleRate}`);
        }
        
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
            timeLog('Audio context resumed');
        }

        // Set up audio context for spatial audio
        const listener = audioContext.listener;
        if (typeof listener.positionX !== 'undefined') {
            listener.positionX.value = 0;
            listener.positionY.value = 0;
            listener.positionZ.value = 0;
        } else {
            listener.setPosition(0, 0, 0);
        }

        timeLog('Audio context initialized');
    } catch (error) {
        console.error('Audio initialization error:', error);
        timeLog(`Audio Error: ${error.message}`);
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

// Update the playAudio function to include gain control
async function playAudio(audioData) {
    try {
        if (!audioContext) {
            await initializeAudioContext();
        }

        // Create a gain node for volume control
        //const gainNode = audioContext.createGain();
        //gainNode.gain.value = 0.5; // Set volume to 50%

        // Get or create the panner for this voice
        const panner = getPersonalityPanner(audioData.voiceId, audioData.position);
        
        // Create audio element
        const audio = new Audio(URL.createObjectURL(audioData.blob));
        audio.preservesPitch = true; // Maintain audio quality
        
        // Create media element source
        const source = audioContext.createMediaElementSource(audio);
        
        // Connect nodes: source -> gain -> panner -> destination
        source.connect(gainNode);
        gainNode.connect(panner);
        
        // Store current audio element
        currentAudioElement = audio;
        currentAudioData = audioData;
        
        // Add event listeners
        audio.addEventListener('ended', () => {
            URL.revokeObjectURL(audio.src);
            if (currentAudioElement === audio) {
                currentAudioElement = null;
                currentAudioData = null;
            }
        });

        // Start playback
        await audio.play();
        timeLog('Started audio playback');

    } catch (error) {
        console.error('Error playing audio:', error);
        timeLog(`Playback error: ${error.message}`);
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

// Update getUserMedia options with correct sample rate
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('startBtn').onclick = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1,
                    sampleRate: 44100  // Standard CD-quality sample rate
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
            timeLog("Listening stopped");
        }
        document.getElementById('startBtn').disabled = false;
        document.getElementById('stopBtn').disabled = true;
    };
}); 
