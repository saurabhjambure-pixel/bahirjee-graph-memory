// Memory Service - Per-Company Persistent Storage
// Stores reactions, notes, and analysis history per domain

const MEMORY_PREFIX = 'bahirjee_memory_';

function getDomainKey(websiteUrl) {
    const domain = websiteUrl.replace(/https?:\/\//, '').split('/')[0];
    return `${MEMORY_PREFIX}${domain.replace(/\./g, '_')}`;
}

function getMemory(websiteUrl) {
    const key = getDomainKey(websiteUrl);
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : {
        domain: websiteUrl,
        analysis_count: 0,
        last_analysis: null,
        last_context: null,
        insight_reactions: {},  // { insight_id: emoji }
        signal_reactions: {},   // { signal_id: emoji }
        user_notes: [],         // Array of notes
        created_at: new Date().toISOString()
    };
}

function saveMemory(websiteUrl, memory) {
    const key = getDomainKey(websiteUrl);
    localStorage.setItem(key, JSON.stringify(memory));
}

export const memoryService = {
    // Get memory for a company
    getMemory,

    // Increment analysis count and update timestamp
    recordAnalysis(websiteUrl, context) {
        const memory = getMemory(websiteUrl);
        memory.analysis_count += 1;
        memory.last_analysis = new Date().toISOString();
        memory.last_context = context;
        saveMemory(websiteUrl, memory);
        return memory;
    },

    // Save a reaction to an insight
    saveInsightReaction(websiteUrl, insightIndex, reaction) {
        const memory = getMemory(websiteUrl);
        memory.insight_reactions[`insight_${insightIndex}`] = reaction;
        saveMemory(websiteUrl, memory);
    },

    // Save a reaction to a signal
    saveSignalReaction(websiteUrl, signalId, reaction) {
        const memory = getMemory(websiteUrl);
        memory.signal_reactions[signalId] = reaction;
        saveMemory(websiteUrl, memory);
    },

    // Add a user note
    addNote(websiteUrl, note) {
        const memory = getMemory(websiteUrl);
        memory.user_notes.push({
            text: note,
            timestamp: new Date().toISOString()
        });
        saveMemory(websiteUrl, memory);
    },

    // Get previous signals for incremental learning
    getPreviousSignals(websiteUrl) {
        const memory = getMemory(websiteUrl);
        return memory.last_context?.signals || [];
    },

    // Get analysis count for displaying "You've analyzed this X times"
    getAnalysisCount(websiteUrl) {
        const memory = getMemory(websiteUrl);
        return memory.analysis_count;
    },

    // Get all reactions for feeding into AI
    getReactionsSummary(websiteUrl) {
        const memory = getMemory(websiteUrl);
        const insights = Object.entries(memory.insight_reactions);
        const signals = Object.entries(memory.signal_reactions);
        return {
            positive: [...insights, ...signals].filter(([_, r]) => ['👍', '🔥', '💡'].includes(r)).length,
            concerns: [...insights, ...signals].filter(([_, r]) => ['⚠️', '👎'].includes(r)).length,
            notes: memory.user_notes.length
        };
    }
};
