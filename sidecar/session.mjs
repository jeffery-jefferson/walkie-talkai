import { CopilotClient, CopilotSession, approveAll } from "@github/copilot-sdk";

export class SessionManager {
  constructor() {
    this.client = null;
    this.session = null;
    this._deltaUnsub = null;
    this._idleUnsub = null;
    this._errorUnsub = null;
  }

  _cleanupListeners() {
    if (this._deltaUnsub) { this._deltaUnsub(); this._deltaUnsub = null; }
    if (this._idleUnsub) { this._idleUnsub(); this._idleUnsub = null; }
    if (this._errorUnsub) { this._errorUnsub(); this._errorUnsub = null; }
  }

  async init(model, systemPrompt) {
    try {
      // Initialize client
      this.client = new CopilotClient();
      await this.client.start();

      // Create session
      this.session = await this.client.createSession({
        model,
        streaming: true,
        onPermissionRequest: approveAll,
        systemMessage: { mode: "replace", content: systemPrompt },
      });

      return true;
    } catch (error) {
      console.error("SessionManager init error:", error);
      throw new Error(`Failed to initialize session: ${error.message}`);
    }
  }

  async send(prompt, onToken) {
    if (!this.session) {
      throw new Error("Session not initialized. Call init() first.");
    }

    try {
      // Clean up any listeners from a previous in-flight request
      this._cleanupListeners();

      let fullText = "";

      // Set up token streaming
      this._deltaUnsub = this.session.on("assistant.message_delta", (e) => {
        const chunk = e.data.deltaContent;
        if (chunk) {
          fullText += chunk;
          onToken(chunk);
        }
      });

      // Wait for session to become idle (completion)
      const idle = new Promise((resolve, reject) => {
        this._idleUnsub = this.session.on("session.idle", () => {
          resolve();
        });

        // Add error handling
        this._errorUnsub = this.session.on("error", (error) => {
          reject(error);
        });
      });

      // Send the prompt
      await this.session.send({ prompt });
      
      // Wait for completion
      await idle;
      
      // Clean up event listeners
      this._cleanupListeners();

      return fullText;
    } catch (error) {
      this._cleanupListeners();
      console.error("SessionManager send error:", error);
      throw new Error(`Failed to send prompt: ${error.message}`);
    }
  }

  async switchModel(model) {
    if (!this.session) {
      throw new Error("Session not initialized. Call init() first.");
    }

    try {
      await this.session.setModel(model);
      return true;
    } catch (error) {
      console.error("SessionManager switchModel error:", error);
      throw new Error(`Failed to switch model: ${error.message}`);
    }
  }

  async reset() {
    try {
      if (this.session) {
        // Store current settings
        const currentModel = this.session.model;
        const currentSystemMessage = this.session.systemMessage;
        
        // Destroy current session
        await this.session.destroy();
        
        // Create new session with same settings
        this.session = await this.client.createSession({
          model: currentModel,
          streaming: true,
          onPermissionRequest: approveAll,
          systemMessage: currentSystemMessage,
        });
      }
      return true;
    } catch (error) {
      console.error("SessionManager reset error:", error);
      throw new Error(`Failed to reset session: ${error.message}`);
    }
  }

  async stop() {
    try {
      if (this.session) {
        await this.session.destroy();
        this.session = null;
      }
      
      if (this.client) {
        await this.client.stop();
        this.client = null;
      }
      
      return true;
    } catch (error) {
      console.error("SessionManager stop error:", error);
      throw new Error(`Failed to stop session: ${error.message}`);
    }
  }
}