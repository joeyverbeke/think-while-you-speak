function timeLog(message, startTime) {
    const elapsed = startTime ? ((Date.now() - startTime) / 1000).toFixed(2) : 0;
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${message}${startTime ? ` (${elapsed}s)` : ''}`);
    return Date.now();
}

let vadInstance;
let audioQueue = []; // Queue of audio blobs to play
let currentAudioElement = null;
let isCurrentlySpeaking = false;
let currentAudioBlob = null; // Keep track of the current audio blob
let currentPlaybackTime = 0; // Track current playback position
let isProcessing = false; // Flag to track if we're processing a response
let pendingTranscriptions = []; // Store transcriptions while processing
let processingPromise = null; // Store the current processing promise

async function playAudio(blob, resumeTime = 0) {
    const startTime = timeLog('Starting audio playback...');
    if (currentAudioElement) {
        timeLog('Stopping previous audio...');
        currentPlaybackTime = currentAudioElement.currentTime; // Save position before stopping
        currentAudioElement.pause();
        currentAudioElement = null;
    }

    // If it's a new audio blob, reset playback time
    if (currentAudioBlob !== blob) {
        timeLog('New audio file detected, starting from beginning');
        currentAudioBlob = blob;
        currentPlaybackTime = 0;
    }

    const url = URL.createObjectURL(blob);
    currentAudioElement = new Audio(url);
    
    // Set up ended handler to play next audio if still speaking
    currentAudioElement.onended = () => {
        timeLog('Audio playback ended');
        if (isCurrentlySpeaking && audioQueue.length > 0) {
            timeLog('Playing next queued audio');
            currentPlaybackTime = 0; // Reset for new audio
            playAudio(audioQueue.shift());
        }
    };

    if (isCurrentlySpeaking) {
        if (currentPlaybackTime > 0) {
            timeLog(`Resuming audio from ${currentPlaybackTime.toFixed(2)}s`);
            currentAudioElement.currentTime = currentPlaybackTime;
        }
        await currentAudioElement.play();
        timeLog('Audio playback started', startTime);
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
            const startTime = timeLog('🎤 Speech detected');
            isCurrentlySpeaking = true;

            // If we have queued audio, start playing it
            if (audioQueue.length > 0) {
                timeLog('Playing new queued audio');
                currentPlaybackTime = 0; // Reset for new audio
                playAudio(audioQueue.shift());
            } else if (currentAudioBlob) {
                // Resume current audio if available
                timeLog('Resuming current audio');
                playAudio(currentAudioBlob);
            } else {
                // Try to get the last generated audio
                const lastAudio = await fetchLastAudio();
                if (lastAudio) {
                    timeLog('Playing last available audio');
                    playAudio(lastAudio);
                }
            }
        },
        onSpeechEnd: async (audio) => {
            const startTime = timeLog('🎤 Speech ended, processing...');
            isCurrentlySpeaking = false;

            // Save current position before stopping
            if (currentAudioElement && !currentAudioElement.ended) {
                currentPlaybackTime = currentAudioElement.currentTime;
                timeLog(`Saving playback position: ${currentPlaybackTime.toFixed(2)}s`);
                currentAudioElement.pause();
                currentAudioElement = null;
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
        // Send to Llama
        timeLog('Sending to Llama...');
        const llamaResponse = await fetch('/query-llama', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                transcription: transcription 
            })
        });

        if (!llamaResponse.ok) {
            throw new Error(`Llama query failed with ${llamaResponse.status}`);
        }

        const { response: llamaResult } = await llamaResponse.json();
        
        // Generate speech
        timeLog('Generating speech...');
        const response = await fetch('/process-text', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ text: llamaResult })
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
        }

        const audioBlob = await response.blob();
        audioQueue.push(audioBlob);
        timeLog('Full end-to-end processing complete', startTime);
        
        return true;
    } catch (error) {
        console.error("Error in end-to-end processing:", error);
        return false;
    }
}

// Initialize event listeners when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('startBtn').onclick = initializeVAD;
    
    document.getElementById('stopBtn').onclick = () => {
        if (vadInstance) {
            vadInstance.pause();
            console.log("Listening stopped.");
        }
    };
}); 