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
let hasAudioBeenInitialized = false; // Flag to track iOS audio initialization
let keepAliveAudio;

// DOM elements
let statusEl;
let startBtn;
let stopBtn;
let debugEl;

// Add device selection state
let selectedInputDevice = null;

function updateStatus(message) {
    if (statusEl) {
        statusEl.textContent = message;
        timeLog(message);
    }
}

function addDebugInfo(message) {
    if (debugEl) {
        debugEl.textContent += message + '\n';
        if (debugEl.textContent.split('\n').length > 5) {
            const lines = debugEl.textContent.split('\n');
            debugEl.textContent = lines.slice(lines.length - 5).join('\n');
        }
    }
}

function timeLog(message, startTime) {
    const elapsed = startTime ? ((Date.now() - startTime) / 1000).toFixed(2) : 0;
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${message}${startTime ? ` (${elapsed}s)` : ''}`);
    return Date.now();
}

// Special handling for iOS audio context
function initializeIOSAudio() {
    if (hasAudioBeenInitialized) return Promise.resolve();
    
    return new Promise((resolve) => {
        // Get the keep-alive audio element
        keepAliveAudio = document.getElementById('keepAliveAudio');
        
        // Configure audio session for background playback
        if (keepAliveAudio) {
            keepAliveAudio.volume = 0.001; // Nearly silent
            keepAliveAudio.play().catch(console.error);
        }
        
        // Create audio context with specific options for iOS
        const audioContextOptions = {
            // Enable low latency mode
            latencyHint: 'interactive',
            // Use sample rate that works well on iOS
            sampleRate: 44100
        };
        
        const tempContext = new (window.AudioContext || window.webkitAudioContext)(audioContextOptions);
        
        // Create and play a silent audio buffer to keep session alive
        const silentBuffer = tempContext.createBuffer(1, 1024, tempContext.sampleRate);
        const source = tempContext.createBufferSource();
        source.buffer = silentBuffer;
        source.connect(tempContext.destination);
        source.start();
        
        // Enable audio session
        if (navigator.mediaSession) {
            navigator.mediaSession.setActionHandler('play', () => {});
            navigator.mediaSession.setActionHandler('pause', () => {});
            navigator.mediaSession.playbackState = "playing";
        }
        
        // On iOS, this gesture unlocks the audio
        tempContext.resume().then(() => {
            timeLog('iOS audio initialized for background playback');
            hasAudioBeenInitialized = true;
            resolve();
        });
    });
}

// Modify getAudioDevices to only handle input devices
async function getAudioDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioDevices = {
        inputs: devices.filter(device => device.kind === 'audioinput')
    };
    timeLog(`Found ${audioDevices.inputs.length} input devices:`);
    audioDevices.inputs.forEach(device => {
        timeLog(`- ${device.label} (${device.deviceId})`);
    });
    return audioDevices;
}

// Update createDeviceSelectors to only create input selector
function createDeviceSelectors(audioDevices) {
    const container = document.querySelector('.button-container');
    
    // Create input selector
    const inputSelector = document.createElement('select');
    inputSelector.id = 'inputSelector';
    inputSelector.className = 'device-selector';
    
    // Add a default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.text = 'Default Microphone';
    inputSelector.appendChild(defaultOption);
    
    audioDevices.inputs.forEach(device => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `Microphone ${device.deviceId.slice(0, 5)}`;
        inputSelector.appendChild(option);
    });
    
    // Add to page before the start button
    container.insertBefore(inputSelector, startBtn);
    
    return { inputSelector };
}

// Modify initializeAudioContext to use selected output device
async function initializeAudioContext() {
    try {
        if (!audioContext) {
            // Use the same options as in initializeIOSAudio
            const audioContextOptions = {
                latencyHint: 'interactive',
                sampleRate: 44100
            };
            audioContext = new (window.AudioContext || window.webkitAudioContext)(audioContextOptions);
        }
        
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        // If we have a selected output device and the browser supports setSinkId
        if (selectedInputDevice && typeof HTMLAudioElement.prototype.setSinkId === 'function') {
            // Create a dummy audio element to set the sink ID
            const dummy = new Audio();
            await dummy.setSinkId(selectedInputDevice);
            timeLog(`Set audio output to device: ${selectedInputDevice}`);
        }
        
        // Set up listener position only
        const listener = audioContext.listener;
        
        // Different browsers use different methods to set listener position
        if (typeof listener.positionX !== 'undefined') {
            listener.positionX.value = 0;
            listener.positionY.value = 0;
            listener.positionZ.value = 0;
            listener.forwardX.value = 0;
            listener.forwardY.value = 0;
            listener.forwardZ.value = -1;
            listener.upX.value = 0;
            listener.upY.value = 1;
            listener.upZ.value = 0;
        } else {
            // Fallback for older browsers/Safari
            listener.setPosition(0, 0, 0);
            listener.setOrientation(0, 0, -1, 0, 1, 0);
        }
        
        timeLog('Audio context initialized');
        updateStatus('Audio initialized');
    } catch (error) {
        console.error('Audio initialization error:', error);
        updateStatus('Audio initialization failed');
    }
}

// Add function to get or create panner for a personality with iOS compatibility
function getPersonalityPanner(personalityId, position) {
    if (!pannerNodes.has(personalityId)) {
        const panner = audioContext.createPanner();
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        
        // Set position in a cross-browser compatible way
        if (typeof panner.positionX !== 'undefined') {
            panner.positionX.value = position.x;
            panner.positionY.value = position.y;
            panner.positionZ.value = position.z;
        } else {
            // Fallback for older browsers/Safari
            panner.setPosition(position.x, position.y, position.z);
        }
        
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
    updateStatus(`Playing voice: ${personalityId}`);
    
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
        updateStatus('Error playing audio');
    }
}

async function fetchLastAudio() {
    const startTime = timeLog('Fetching last audio...');
    try {
        const response = await fetch('/last-audio');
        if (response.ok) {
            timeLog('Successfully fetched last audio', startTime);
            return await response.blob();
        }
        timeLog('No audio available', startTime);
        return null;
    } catch (error) {
        console.error('Error fetching initial audio:', error);
        return null;
    }
}

// Update VAD initialization to properly use selected input device
async function initializeVAD() {
    updateStatus('Initializing speech detection...');
    const startTime = timeLog('Initializing VAD...');
    
    try {
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        
        // Get current input device constraints
        const constraints = {
            audio: selectedInputDevice ? 
                {
                    deviceId: { exact: selectedInputDevice },
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                } : 
                true
        };

        // Test the constraints before VAD initialization
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        timeLog('Successfully got media stream with constraints:', constraints);

        const vadConfig = {
            model: 'legacy',
            audioConstraints: constraints,
            positiveSpeechThreshold: isIOS ? 0.8 : 0.5,
            negativeSpeechThreshold: isIOS ? 0.5 : 0.35,
            minSpeechFrames: isIOS ? 7 : 3,
            preSpeechPadFrames: isIOS ? 7 : 5,
            samplingRate: isIOS ? 16000 : 48000,
            frameSamples: isIOS ? 512 : 1024,

            // Event handlers must be part of initial configuration
            onSpeechStart: () => {
                timeLog('🎤 Speech detected');
                isCurrentlySpeaking = true;
                updateStatus('Listening...');

                // If this is the first speech, play initial response
                if (isFirstSpeech) {
                    timeLog('Playing initial response');
                    fetch('/last-audio').then(async response => {
                        if (response.ok) {
                            const blob = await response.blob();
                            playAudio({
                                blob,
                                voiceId: 'advisor',
                                position: { x: 0, y: 0, z: 1 }
                            });
                        }
                        isFirstSpeech = false;
                    });
                }
                // If there's queued audio, always prefer that over current audio
                else if (audioQueue.length > 0) {
                    timeLog('Playing new queued audio');
                    currentAudioData = null;  // Clear current audio
                    playAudio(audioQueue.shift());
                } else if (currentAudioData) {
                    timeLog('Resuming current audio');
                    playAudio(currentAudioData);
                }
            },

            onSpeechEnd: async (audio) => {
                timeLog('🎤 Speech ended, processing...');
                updateStatus('Processing your speech...');
                isCurrentlySpeaking = false;

                // Save current position before stopping
                if (currentAudioElement) {
                    try {
                        timeLog(`Saving playback position: ${currentPlaybackTime ? currentPlaybackTime.toFixed(2) : 0}s`);
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
                    
                    timeLog('Transcribing recorded speech...');
                    updateStatus('Transcribing...');
                    
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
                    addDebugInfo(`You: ${transcription}`);

                    // Process the transcription
                    if (transcription.trim()) {
                        await processUserSpeech(transcription);
                    }

                    timeLog('Speech handling complete', startTime);
                    updateStatus('Ready');
                } catch (error) {
                    console.error("Error processing speech:", error);
                    updateStatus('Error processing speech');
                }
            }
        };

        // Stop the test stream before creating VAD
        stream.getTracks().forEach(track => track.stop());

        timeLog('Creating VAD with config:', vadConfig);
        vadInstance = await vad.MicVAD.new(vadConfig);
        
        // Start VAD immediately
        await vadInstance.start();
        timeLog('VAD initialization complete', startTime);
        updateStatus('Ready! Start speaking...');
        
        // Update button states
        if (startBtn) startBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = false;
        
    } catch (error) {
        console.error("Error initializing VAD:", error);
        console.error("Detailed error:", error.message);
        if (error.stack) console.error("Stack trace:", error.stack);
        
        updateStatus('Failed to initialize speech detection. Please try reloading the page.');
        
        // Reset button states
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
    }
}

async function processUserSpeech(transcription) {
    const startTime = timeLog('Starting end-to-end processing');
    updateStatus('Generating response...');
    
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
            updateStatus('Query queued...');
            return true;
        }

        const { response: llamaResult, personalityId, position } = responseData;
        addDebugInfo(`${personalityId}: ${llamaResult}`);
        
        timeLog(`Generating speech for ${personalityId}...`);
        updateStatus('Generating voice...');
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
        updateStatus('Ready');
        
        return true;
    } catch (error) {
        console.error("Error in end-to-end processing:", error);
        updateStatus('Error generating response');
        return false;
    }
}

// Add audio session interruption handling
function handleAudioInterruption() {
    if (navigator.mediaSession) {
        navigator.mediaSession.setActionHandler('play', async () => {
            timeLog('Resuming audio after interruption');
            if (keepAliveAudio && keepAliveAudio.paused) {
                await keepAliveAudio.play();
            }
            if (audioContext && audioContext.state === 'suspended') {
                await audioContext.resume();
            }
        });
    }
}

// Initialize event listeners when the DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    statusEl = document.getElementById('status');
    startBtn = document.getElementById('startBtn');
    stopBtn = document.getElementById('stopBtn');
    debugEl = document.getElementById('debug');
    
    stopBtn.disabled = true;
    
    try {
        // Get initial device permissions
        await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Get available devices
        const audioDevices = await getAudioDevices();
        
        // Create input selector
        const { inputSelector } = createDeviceSelectors(audioDevices);
        
        // Listen for device selection changes
        inputSelector.onchange = async (e) => {
            selectedInputDevice = e.target.value;
            timeLog(`Selected input device: ${selectedInputDevice}`);
            
            // Restart VAD if it's running
            if (vadInstance) {
                vadInstance.pause();
                await initializeVAD();
            }
        };
        
        // Try to automatically select Bluetooth device if available
        const bluetoothInput = audioDevices.inputs.find(d => 
            d.label.toLowerCase().includes('bluetooth') || 
            d.label.toLowerCase().includes('airpods')
        );
        
        if (bluetoothInput) {
            inputSelector.value = bluetoothInput.deviceId;
            selectedInputDevice = bluetoothInput.deviceId;
            timeLog(`Auto-selected Bluetooth device: ${bluetoothInput.label}`);
        }
    } catch (error) {
        console.error('Error setting up device selection:', error);
    }
    
    startBtn.onclick = async () => {
        updateStatus('Initializing audio...');
        
        try {
            // Check if we're in a secure context
            if (!window.isSecureContext) {
                throw new Error('Microphone access requires HTTPS. Please use a secure connection.');
            }

            // Check if mediaDevices is available
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('Your browser does not support microphone access. Please use Safari on iOS 14.3 or later.');
            }

            // Request microphone permission
            await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Initialize audio specifically for iOS
            await initializeIOSAudio();
            
            // Initialize regular audio context
            if (!audioContext) {
                initializeAudioContext();
            }
            
            // Start VAD after audio is initialized
            await initializeVAD();
        } catch (error) {
            console.error('Error starting app:', error);
            let errorMessage = 'Microphone access denied. ';
            
            if (!window.isSecureContext) {
                errorMessage = 'Please use HTTPS to enable microphone access.';
            } else if (!navigator.mediaDevices) {
                errorMessage = 'Browser not supported. Please use Safari on iOS.';
            } else {
                errorMessage += 'Please check permissions and try again.';
            }
            
            updateStatus(errorMessage);
            if (startBtn) startBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = true;
        }
    };
    
    stopBtn.onclick = () => {
        if (vadInstance) {
            vadInstance.pause();
            timeLog("Listening stopped.");
            updateStatus('Stopped');
            
            startBtn.disabled = false;
            stopBtn.disabled = true;
        }
    };
    
    // Initialize audio interruption handling
    handleAudioInterruption();
});

// Prevent iOS from going to sleep
document.addEventListener('touchstart', () => {
    if (!audioContext) return;
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
});

// Add a timeout to auto-stop after long periods of inactivity (battery saving)
let inactivityTimer;
function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
        if (vadInstance && !isProcessing) {
            vadInstance.pause();
            updateStatus('Stopped due to inactivity');
            if (startBtn) startBtn.disabled = false;
            if (stopBtn) stopBtn.disabled = true;
        }
    }, 5 * 60 * 1000); // 5 minutes
}

// Reset timer on any user interaction
['touchstart', 'mousedown', 'keydown'].forEach(event => {
    document.addEventListener(event, resetInactivityTimer);
});

// Add visibility change handler
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Page is hidden (locked/background)
        timeLog('Page hidden - ensuring audio continues');
        if (keepAliveAudio && keepAliveAudio.paused) {
            keepAliveAudio.play().catch(console.error);
        }
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume().catch(console.error);
        }
    }
}); 