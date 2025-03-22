// Configuration management
const CONFIG = {
  // Default values that will be overwritten if stored in localStorage
  serverUrl: window.location.origin,
  
  // Load configuration
  load() {
    try {
      const saved = localStorage.getItem('appConfig');
      if (saved) {
        const parsed = JSON.parse(saved);
        Object.assign(this, parsed);
      }
    } catch (e) {
      console.error('Error loading config:', e);
    }
    return this;
  },
  
  // Save configuration
  save() {
    try {
      localStorage.setItem('appConfig', JSON.stringify({
        serverUrl: this.serverUrl
      }));
    } catch (e) {
      console.error('Error saving config:', e);
    }
  },
  
  // Update and save
  update(values) {
    Object.assign(this, values);
    this.save();
  }
};

// Load config immediately
CONFIG.load(); 