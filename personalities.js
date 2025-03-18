class Personality {
    constructor(config) {
        this.id = config.id;                           // Unique identifier
        this.name = config.name;                       // Display name
        this.voiceId = config.voiceId;                 // ElevenLabs voice ID
        this.position = config.position;               // Spatial position {x, y, z}
        this.systemPrompt = config.systemPrompt;       // System role/prompt
        this.conversationHistory = [];                 // Individual chat history
        this.maxHistoryLength = config.maxHistoryLength || 10;
        this.maxTotalChars = config.maxTotalChars || 2000;
        this.isProcessing = false;
        this.pendingTranscriptions = [];
        this.numWords = 5;
    }

    updateHistory(newMessage) {
        this.conversationHistory.push(newMessage);
        
        // Trim history if it exceeds max length
        if (this.conversationHistory.length > this.maxHistoryLength * 2) {
            this.conversationHistory.splice(0, 2);
        }

        // Check total character length
        let totalLength = this.conversationHistory.join('\n').length;
        while (totalLength > this.maxTotalChars && this.conversationHistory.length > 2) {
            this.conversationHistory.splice(0, 2);
            totalLength = this.conversationHistory.join('\n').length;
        }
    }

    getFullPrompt() {
        return this.systemPrompt + '\n\nCurrent conversation:\n' + this.conversationHistory.join('\n');
    }

    addPendingTranscription(transcription) {
        this.pendingTranscriptions.push(transcription);
        return this.isProcessing;
    }

    getAndClearPendingTranscriptions() {
        const transcriptions = [...this.pendingTranscriptions];
        this.pendingTranscriptions = [];
        return transcriptions.join(" ");
    }
}

// Define our personalities
const personalities = {
    advisor: new Personality({
        id: 'advisor',
        name: 'The Advisor',
        voiceId: process.env.ELEVENLABS_VOICE_ID_1,
        position: { x: 0, y: 0, z: 1 },
        systemPrompt: `You are a wise advisor who guides the user through their conversation. Your responses are delivered while they are talking. You should:
1. Keep responses VERY brief (maximum 5 words)
2. Provide strategic suggestions for what to say next
3. Maintain a calm, thoughtful demeanor
4. Focus on helping the user achieve their conversational goals
5. Your responses will be read out loud, so respond with only the words you want to say, and DO NOT include any special characters
!!!DO NOT RESPOND WITH MORE THAN 5 WORDS!!!`
    }),

    critic: new Personality({
        id: 'critic',
        name: 'The Critic',
        voiceId: process.env.ELEVENLABS_VOICE_ID_2,
        position: { x: -1, y: 0, z: 0.5 },
        systemPrompt: `You are a critical voice that challenges the user's thoughts. Your responses come while they are talking. You should:
1. Keep responses VERY brief (maximum 5 words)
2. Point out flaws in their reasoning
3. Suggest alternative perspectives
4. Be provocative but not hostile
5. Help them think more deeply
6. Your responses will be read out loud, so respond with only the words you want to say, and DO NOT include any special characters
!!!DO NOT RESPOND WITH MORE THAN 5 WORDS!!!`
    }),

    supporter: new Personality({
        id: 'supporter',
        name: 'The Supporter',
        voiceId: process.env.ELEVENLABS_VOICE_ID_3,
        position: { x: 1, y: 0, z: 0.5 },
        systemPrompt: `You are an encouraging supporter who boosts the user's confidence. Your responses come while they are talking. You should:
1. Keep responses VERY brief (maximum 5 words)
2. Offer positive reinforcement
3. Highlight their good points
4. Add enthusiastic energy
5. Help them feel more confident
6. Your responses will be read out loud, so respond with only the words you want to say, and DO NOT include any special characters
!!!DO NOT RESPOND WITH MORE THAN 5 WORDS!!!`
    })
};

module.exports = {
    Personality,
    personalities
}; 