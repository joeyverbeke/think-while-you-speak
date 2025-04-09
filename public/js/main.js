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
let isAudioTransitioning = false;
let hasInternet = false;

// Add Raspberry Pi detection
const isRaspberryPi = navigator.userAgent.toLowerCase().includes('linux armv');

// Update VAD initialization
async function initializeVAD() {
    const startTime = timeLog('Initializing VAD...');
    
    try {
        // Configure VAD
        const vadConfig = {
            model: 'legacy',
            positiveSpeechThreshold: 0.7,
            negativeSpeechThreshold: 0.4,
            minSpeechFrames: 4,
            preSpeechPadFrames: 5,
            // Let VAD handle its own audio constraints
            onSpeechStart: async () => {
                timeLog('Speech detected');
                isCurrentlySpeaking = true;

                // Always stop any currently playing audio first
                await stopCurrentAudio();

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

                await stopCurrentAudio();

                if(hasInternet) {
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
                } else {
                    try {
                        const response = await fetch('/debug-audio');
                        if (!response.ok) {
                            throw new Error(`Server responded with ${response.status}`);
                        }
                        
                        const audioBlob = await response.blob();
                        audioQueue.push({
                            blob: audioBlob,
                            voiceId: 'advisor', // Default voice ID for debug mode
                            position: { x: 0, y: 0, z: 1 }, // Default position
                            timestamp: Date.now()
                        });
                        timeLog('Added debug audio to queue');
                    } catch (error) {
                        console.error('Error getting debug audio:', error);
                        timeLog(`Debug audio error: ${error.message}`);
                    }
                    timeLog('No internet connection, using debug audio');
                }
            }
        };

        timeLog('Creating VAD instance...');
        vadInstance = await vad.MicVAD.new(vadConfig);
        timeLog('Starting VAD...');
        await vadInstance.start();
        
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
        // Always stop any currently playing audio first
        await stopCurrentAudio();

        // Wait for any ongoing audio transitions to complete
        if (isAudioTransitioning) {
            timeLog('Waiting for audio transition to complete...');
            await new Promise(resolve => {
                const checkTransition = () => {
                    if (!isAudioTransitioning) {
                        resolve();
                    } else {
                        setTimeout(checkTransition, 10);
                    }
                };
                checkTransition();
            });
        }

        if (!audioContext) {
            await initializeAudioContext();
        }

        const panner = getPersonalityPanner(audioData.voiceId, audioData.position);
        
        const audio = new Audio(URL.createObjectURL(audioData.blob));
        audio.preservesPitch = true;
        
        const source = audioContext.createMediaElementSource(audio);
        source.connect(panner);
        
        currentAudioElement = {
            audio: audio,
            source: source
        };
        currentAudioData = audioData;
        
        audio.addEventListener('ended', () => {
            URL.revokeObjectURL(audio.src);
            if (currentAudioElement && currentAudioElement.audio === audio) {
                currentAudioElement.source.disconnect();
                currentAudioElement = null;
                currentAudioData = null;
            }
        });

        await audio.play();
        timeLog('Started audio playback');

    } catch (error) {
        console.error('Error playing audio:', error);
        timeLog(`Playback error: ${error.message}`);
        // Clean up on error
        if (currentAudioElement) {
            currentAudioElement.source.disconnect();
            currentAudioElement = null;
            currentAudioData = null;
        }
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

document.addEventListener('DOMContentLoaded', async () => {
    try {
        timeLog('Starting application initialization');
        
        // Initialize VAD first - let it handle microphone access
        await initializeVAD();
        
        // Now initialize audio context after VAD is ready
        await initializeAudioContext();
        
        // Play a short audio immediately to ensure audio works after minimizing
        try {
            timeLog('Playing startup audio to ensure audio works when minimized...');
            const initialResponse = await fetch('/last-audio');
            if (initialResponse.ok) {
                const blob = await initialResponse.blob();
                await playAudio({
                    blob,
                    voiceId: 'advisor',
                    position: { x: 0, y: 0, z: 1 }
                });
                timeLog('Startup audio playback initiated');
            } else {
                // If no audio file exists yet, play a silent audio to initialize the audio system
                timeLog('No startup audio available, creating silent audio...');
                // Create a short silent audio context
                const silentContext = new (window.AudioContext || window.webkitAudioContext)();
                const oscillator = silentContext.createOscillator();
                oscillator.connect(silentContext.destination);
                oscillator.start();
                oscillator.stop(silentContext.currentTime + 0.1);
                timeLog('Silent audio played');
            }
        } catch (error) {
            console.error('Error playing startup audio:', error);
            timeLog('Startup audio error: ' + error.message);
        }
        
        // Hide buttons since we don't need them
        document.getElementById('startBtn').style.display = 'none';
        document.getElementById('stopBtn').style.display = 'none';
        
        timeLog('Application initialized successfully');
    } catch (error) {
        console.error('Error starting application:', error);
        timeLog('Failed to start: ' + error.message);
        // Show error in page since we're headless
        const errorDiv = document.createElement('div');
        errorDiv.style.color = 'red';
        errorDiv.textContent = 'Failed to start: ' + error.message;
        document.body.appendChild(errorDiv);
    }
});

// Update the onSpeechEnd handler to properly stop audio
async function stopCurrentAudio() {
    if (!currentAudioElement) return;

    isAudioTransitioning = true;
    try {
        timeLog('Stopping current audio playback');
        
        // Create a local reference in case currentAudioElement changes during execution
        const audioToStop = currentAudioElement;
        
        // Pause the audio
        if (audioToStop.audio && !audioToStop.audio.paused) {
            await audioToStop.audio.pause();
        }
        
        // Disconnect the source
        if (audioToStop.source) {
            try {
                audioToStop.source.disconnect();
            } catch (e) {
                // Ignore errors if already disconnected
            }
        }
        
        // Clear the URL if it exists
        if (audioToStop.audio && audioToStop.audio.src) {
            URL.revokeObjectURL(audioToStop.audio.src);
        }
        
        // Clear the references
        if (currentAudioElement === audioToStop) {
            currentAudioElement = null;
            currentAudioData = null;
        }
        
        timeLog('Audio playback stopped');
    } catch (error) {
        console.error('Error stopping audio:', error);
        timeLog(`Stop audio error: ${error.message}`);
        
        // Force reset on error
        currentAudioElement = null;
        currentAudioData = null;
    } finally {
        isAudioTransitioning = false;
    }
} 
