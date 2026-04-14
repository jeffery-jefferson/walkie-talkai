#!/usr/bin/env node

import { createInterface } from 'readline';
import { SessionManager } from './session.mjs';

class SidecarBridge {
  constructor() {
    this.sessionManager = new SessionManager();
    this.setupReadline();
    this.setupGracefulShutdown();
  }

  setupReadline() {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    this.rl.on('line', (line) => {
      this.handleCommand(line.trim());
    });

    this.rl.on('close', () => {
      this.cleanup();
    });
  }

  setupGracefulShutdown() {
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
    process.on('uncaughtException', (error) => {
      this.emitError(`Uncaught exception: ${error.message}`);
      this.cleanup(1);
    });
    process.on('unhandledRejection', (reason) => {
      this.emitError(`Unhandled rejection: ${reason}`);
      this.cleanup(1);
    });
  }

  emit(event) {
    // CRITICAL: Use process.stdout directly, not console.log
    process.stdout.write(JSON.stringify(event) + '\n');
  }

  emitError(message) {
    this.emit({ type: "error", message });
    console.error("Sidecar error:", message);  // This goes to stderr, safe
  }

  async handleCommand(line) {
    if (!line) return;
    
    try {
      const command = JSON.parse(line);
      
      switch (command.type) {
        case 'init':
          await this.handleInit(command);
          break;
          
        case 'send':
          await this.handleSend(command);
          break;
          
        case 'switch_model':
          await this.handleSwitchModel(command);
          break;
          
        case 'reset':
          await this.handleReset(command);
          break;
          
        case 'stop':
          await this.handleStop(command);
          break;
          
        default:
          this.emitError(`Unknown command type: ${command.type}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.emitError(`Invalid JSON: ${error.message}`);
      } else {
        this.emitError(`Command handling error: ${error.message}`);
      }
    }
  }

  async handleInit(command) {
    const { model, systemPrompt } = command;
    
    if (!model) {
      this.emitError("Missing required parameter: model");
      return;
    }
    
    if (!systemPrompt) {
      this.emitError("Missing required parameter: systemPrompt");
      return;
    }

    try {
      await this.sessionManager.init(model, systemPrompt);
      this.emit({ type: "ready" });
    } catch (error) {
      this.emitError(error.message);
    }
  }

  async handleSend(command) {
    const { prompt } = command;
    
    if (!prompt) {
      this.emitError("Missing required parameter: prompt");
      return;
    }

    try {
      // Check if session is initialized
      if (!this.sessionManager.session) {
        this.emitError("Session not initialized. Call init() first.");
        return;
      }

      const fullText = await this.sessionManager.send(prompt, (token) => {
        this.emit({ type: "token", content: token });
      });
      
      this.emit({ type: "done", fullText });
    } catch (error) {
      this.emitError(error.message);
    }
  }

  async handleSwitchModel(command) {
    const { model } = command;
    
    if (!model) {
      this.emitError("Missing required parameter: model");
      return;
    }

    try {
      await this.sessionManager.switchModel(model);
      this.emit({ type: "model_switched", model });
    } catch (error) {
      this.emitError(error.message);
    }
  }

  async handleReset(command) {
    try {
      await this.sessionManager.reset();
      this.emit({ type: "session_reset" });
    } catch (error) {
      this.emitError(error.message);
    }
  }

  async handleStop(command) {
    try {
      await this.sessionManager.stop();
      this.cleanup(0);
    } catch (error) {
      this.emitError(error.message);
      this.cleanup(1);
    }
  }

  async cleanup(exitCode = 0) {
    try {
      if (this.sessionManager) {
        await this.sessionManager.stop();
      }
      
      if (this.rl) {
        this.rl.close();
      }
    } catch (error) {
      console.error("Cleanup error:", error);
    } finally {
      process.exit(exitCode);
    }
  }
}

// Start the sidecar bridge
const bridge = new SidecarBridge();

// Emit ready signal to indicate the sidecar is running
console.error("Copilot SDK sidecar started");  // Debug info to stderr