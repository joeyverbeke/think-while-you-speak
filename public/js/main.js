// Global state
let vadInstance;
let audioQueue = []; 
let currentAudioData = null;
let currentAudioElement = null;
let isCurrentlySpeaking = false;
let currentPlaybackTime = 0;
let isProcessing = false;
let processingPromise = null;
let audioContext;
let pannerNodes = new Map();
let isFirstSpeech = true;
let hasAudioBeenInitialized = false;

// DOM elements
let statusEl, startBtn, stopBtn, debugEl, settingsBtn, settingsPanel;
let serverUrlInput, saveSettingsBtn, cancelSettingsBtn;

// Log both to console and debug div
function log(message, data) {
  const timestamp = new Date().toLocaleTimeString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage, data || '');
  
  if (debugEl) {
    const logLine = document.createElement('div');
    logLine.textContent = data ? `${logMessage} ${JSON.stringify(data)}` : logMessage;
    debugEl.appendChild(logLine);
    
    // Limit to last 50 messages
    while (debugEl.childNodes.length > 50) {
      debugEl.removeChild(debugEl.firstChild);
    }
    
    // Scroll to bottom
    debugEl.scrollTop = debugEl.scrollHeight;
  }
  
  return Date.now();
}

function updateStatus(message) {
  if (statusEl) {
    statusEl.textContent = message;
    log(message);
  }
}

// Initialize audio context suitable for the current browser
function initializeAudioContext() {
  try {
    if (!audioContext) {
      const options = { latencyHint: 'interactive' };
      audioContext = new (window.AudioContext || window.webkitAudioContext)(options);
    }
    
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    
    // Set up listener position
    const listener = audioContext.listener;
    
    // Different browsers use different methods
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
      // Fallback for older browsers
      listener.setPosition(0, 0, 0);
      listener.setOrientation(0, 0, -1, 0, 1, 0);
    }
    
    log('Audio context initialized');
    hasAudioBeenInitialized = true;
  } catch (error) {
    console.error('Audio API not supported:', error);
    updateStatus('Audio initialization failed');
    throw error;
  }
}

// Cross-browser compatible way to get/create panner node
function getPersonalityPanner(personalityId, position) {
  if (!pannerNodes.has(personalityId)) {
    const panner = audioContext.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    
    // Set position in a cross-browser way
    if (typeof panner.positionX !== 'undefined') {
      panner.positionX.value = position.x;
      panner.positionY.value = position.y;
      panner.positionZ.value = position.z;
    } else {
      panner.setPosition(position.x, position.y, position.z);
    }
    
    panner.connect(audioContext.destination);
    pannerNodes.set(personalityId, panner);
    log(`Created panner for ${personalityId}`, position);
  }
  return pannerNodes.get(personalityId);
}

// Play audio with spatial positioning
async function playAudio(data) {
  if (!data || !data.blob) {
    console.error('Invalid audio data');
    return;
  }

  const { blob, voiceId: personalityId, position } = data;
  if (!position) {
    console.error('No position data for personality:', personalityId);
    return;
  }

  log(`Starting audio playback for ${personalityId}`);
  
  if (!audioContext) {
    initializeAudioContext();
  }
  
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  // Store current audio data
  currentAudioData = data;

  // Get panner for this personality
  const panner = getPersonalityPanner(personalityId, position);

  // Stop current audio if playing
  if (currentAudioElement) {
    try {
      currentAudioElement.stop();
    } catch (error) {
      console.error('Error stopping audio:', error);
    }
    currentAudioElement = null;
  }

  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(panner);
    
    source.onended = () => {
      log('Audio playback ended');
      if (isCurrentlySpeaking && audioQueue.length > 0) {
        log('Playing next queued audio');
        currentPlaybackTime = 0;
        playAudio(audioQueue.shift());
      }
    };

    if (isCurrentlySpeaking) {
      source.start(0, currentPlaybackTime);
      log('Audio playback started');
    }

    currentAudioElement = source;
  } catch (error) {
    console.error(`Error playing audio:`, error);
  }
}

// Fetch audio from the server
async function fetchLastAudio() {
  log('Fetching last audio...');
  try {
    const response = await fetch(`${CONFIG.serverUrl}/last-audio`);
    if (response.ok) {
      log('Successfully fetched last audio');
      return await response.blob();
    }
    log('No audio available');
    return null;
  } catch (error) {
    console.error('Error fetching audio:', error);
    return null;
  }
}

// Initialize VAD with browser-specific optimizations
async function initializeVAD() {
  log('Initializing VAD...');
  updateStatus('Setting up voice detection...');
  
  try {
    // Check if browser is Safari/iOS
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    
    // Configure VAD based on browser/device
    const vadConfig = {
      // Use different models depending on browser
      model: isSafari || isIOS ? 'legacy' : 'legacy',
      
      // Adjust thresholds for better performance
      positiveSpeechThreshold: isIOS ? 0.8 : 0.5,
      negativeSpeechThreshold: isIOS ? 0.5 : 0.35,
      minSpeechFrames: isIOS ? 7 : 3,
      preSpeechPadFrames: 5,
      
      // Audio constraints for better cross-platform support
      audioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      
      // Event handlers
      onSpeechStart: async () => {
        log('🎤 Speech detected');
        isCurrentlySpeaking = true;
        updateStatus('Listening...');

        if (isFirstSpeech) {
          log('Playing initial response');
          const blob = await fetchLastAudio();
          if (blob) {
            playAudio({
              blob,
              voiceId: 'advisor',
              position: { x: 0, y: 0, z: 1 }
            });
          }
          isFirstSpeech = false;
        } 
        else if (audioQueue.length > 0) {
          log('Playing queued audio');
          currentAudioData = null; // Clear current
          playAudio(audioQueue.shift());
        } 
        else if (currentAudioData) {
          log('Resuming current audio');
          playAudio(currentAudioData);
        }
      },
      
      onSpeechEnd: async (audio) => {
        log('🎤 Speech ended, processing...');
        updateStatus('Processing...');
        isCurrentlySpeaking = false;

        if (currentAudioElement) {
          try {
            currentAudioElement.stop();
            currentAudioElement = null;
          } catch (error) {
            console.error('Error stopping audio:', error);
          }
        }

        try {
          // Convert audio data for server
          const wavBuffer = vad.utils.encodeWAV(audio);
          const base64Audio = vad.utils.arrayBufferToBase64(wavBuffer);
          
          log('Sending audio for transcription...');
          
          // Send to server (using the configured URL)
          const response = await fetch(`${CONFIG.serverUrl}/transcribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio: base64Audio })
          });

          if (!response.ok) {
            throw new Error(`Transcription failed: ${response.status}`);
          }

          const { transcription } = await response.json();
          log(`Transcribed: "${transcription}"`);

          if (transcription.trim()) {
            await processUserSpeech(transcription);
          } else {
            updateStatus('Ready');
          }
        } catch (error) {
          console.error('Error processing speech:', error);
          updateStatus('Error processing speech');
        }
      }
    };

    // Create and start VAD instance
    vadInstance = await vad.MicVAD.new(vadConfig);
    await vadInstance.start();
    
    log('VAD initialization complete');
    updateStatus('Ready - Speak to begin');
    
    // Update button states
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } catch (error) {
    console.error('VAD initialization error:', error);
    updateStatus('Voice detection failed to initialize');
    throw error;
  }
}

// Process the user's speech through the server
async function processUserSpeech(transcription) {
  log('Processing user speech:', transcription);
  
  try {
    updateStatus('Generating response...');
    
    // Query the language model
    const llamaResponse = await fetch(`${CONFIG.serverUrl}/query-llama`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcription })
    });

    if (!llamaResponse.ok) {
      throw new Error(`Server error: ${llamaResponse.status}`);
    }

    const responseData = await llamaResponse.json();
    
    if (responseData.queued) {
      log('Request queued for processing');
      updateStatus('Request queued...');
      return;
    }

    const { response, personalityId, position } = responseData;
    log(`Response from ${personalityId}:`, response);
    
    // Generate speech
    updateStatus('Generating voice...');
    const speechResponse = await fetch(`${CONFIG.serverUrl}/process-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        text: response,
        personalityId
      })
    });

    if (!speechResponse.ok) {
      throw new Error(`Speech generation failed: ${speechResponse.status}`);
    }

    const audioBlob = await speechResponse.blob();
    
    // Queue the audio for playback
    audioQueue.push({ 
      blob: audioBlob, 
      voiceId: personalityId,
      position,
      timestamp: Date.now()
    });
    
    log('Processing complete, audio queued');
    updateStatus('Ready');
  } catch (error) {
    console.error('Error in speech processing:', error);
    updateStatus('Error generating response');
  }
}

// Settings panel functions
function showSettings() {
  settingsPanel.style.display = 'block';
  serverUrlInput.value = CONFIG.serverUrl;
}

function hideSettings() {
  settingsPanel.style.display = 'none';
}

function saveSettings() {
  const serverUrl = serverUrlInput.value.trim();
  if (!serverUrl) {
    alert('Server URL is required');
    return;
  }
  
  CONFIG.update({ serverUrl });
  log('Settings updated', { serverUrl });
  hideSettings();
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
  // Get DOM elements
  statusEl = document.getElementById('status');
  startBtn = document.getElementById('startBtn');
  stopBtn = document.getElementById('stopBtn');
  debugEl = document.getElementById('debug');
  settingsBtn = document.getElementById('settingsBtn');
  settingsPanel = document.getElementById('settingsPanel');
  serverUrlInput = document.getElementById('serverUrl');
  saveSettingsBtn = document.getElementById('saveSettingsBtn');
  cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
  
  // Initialize UI
  updateStatus('Welcome! Click Start to begin.');
  
  // Event listeners
  startBtn.addEventListener('click', async () => {
    try {
      // Request microphone access
      await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Initialize audio
      initializeAudioContext();
      
      // Start VAD
      await initializeVAD();
    } catch (error) {
      console.error('Error starting:', error);
      updateStatus(`Error: ${error.message}`);
    }
  });
  
  stopBtn.addEventListener('click', () => {
    if (vadInstance) {
      vadInstance.pause();
      log('Listening stopped');
      updateStatus('Stopped');
      
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  });
  
  settingsBtn.addEventListener('click', showSettings);
  saveSettingsBtn.addEventListener('click', saveSettings);
  cancelSettingsBtn.addEventListener('click', hideSettings);
  
  // Update UI with configuration
  serverUrlInput.value = CONFIG.serverUrl;
  
  // Log startup
  log('Application initialized');
});