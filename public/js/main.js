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

function initializeAudioContext() {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        // Set up listener position only
        const listener = audioContext.listener;
        listener.positionX.value = 0;
        listener.positionY.value = 0;
        listener.positionZ.value = 0;
        listener.forwardX.value = 0;
        listener.forwardY.value = 0;
        listener.forwardZ.value = -1;
        listener.upX.value = 0;
        listener.upY.value = 1;
        listener.upZ.value = 0;
        
        timeLog('Audio context initialized');
    } catch (error) {
        console.error('Web Audio API not supported:', error);
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

async function initializeVAD() {
    const startTime = timeLog('Initializing VAD...');
    vadInstance = await vad.MicVAD.new({
        onSpeechStart: async () => {
            timeLog('🎤 Speech detected');
            isCurrentlySpeaking = true;

            // If there's queued audio, always prefer that over current audio
            if (audioQueue.length > 0) {
                timeLog('Playing new queued audio');
                currentAudioData = null;  // Clear current audio
                playAudio(audioQueue.shift());
            } else if (currentAudioData) {
                timeLog('Resuming current audio');
                playAudio(currentAudioData);
            }
        },
        onSpeechEnd: async (audio) => {
            const startTime = timeLog('🎤 Speech ended, processing...');
            isCurrentlySpeaking = false;

            // Save current position before stopping
            if (currentAudioElement) {
                try {
                    // AudioBufferSourceNode doesn't have currentTime, we need to track it differently
                    timeLog(`Saving playback position: ${currentPlaybackTime.toFixed(2)}s`);
                    currentAudioElement.stop();
                    currentAudioElement = null;
                } catch (error) {
                    console.error('Error stopping audio:', error);
                }
            }

            try {
                // Encode and transcribe the audio
                const encodeStart = Date.now();
                const wavBuffer = vad.utils.encodeWAV(audio);
                const base64Audio = vad.utils.arrayBufferToBase64(wavBuffer);
                
                const response = await fetch('/transcribe', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ audio: base64Audio })
                });

                if (!response.ok) {
                    throw new Error(`Transcription failed with ${response.status}`);
                }

                const { transcription } = await response.json();
                timeLog(`Transcribed: "${transcription}"`, encodeStart);

                // Add to pending transcriptions
                pendingTranscriptions.push(transcription);

                // If we're not currently processing, start a new processing cycle
                if (!isProcessing) {
                    isProcessing = true;
                    
                    while (pendingTranscriptions.length > 0) {
                        // Combine all pending transcriptions
                        const fullTranscription = pendingTranscriptions.join(" ");
                        pendingTranscriptions = []; // Clear pending transcriptions
                        
                        timeLog(`Processing combined transcription: "${fullTranscription}"`);
                        await processUserSpeech(fullTranscription);
                    }
                    
                    isProcessing = false;
                }

                timeLog('Speech handling complete', startTime);
            } catch (error) {
                console.error("Error processing speech:", error);
            }
        }
    });
    vadInstance.start();
    timeLog('VAD initialization complete', startTime);
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

// Initialize event listeners when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('startBtn').onclick = async () => {
        // Initialize audio context on user gesture
        if (!audioContext) {
            initializeAudioContext();
        }
        await initializeVAD();
    };
    
    document.getElementById('stopBtn').onclick = () => {
        if (vadInstance) {
            vadInstance.pause();
            console.log("Listening stopped.");
        }
    };
}); 