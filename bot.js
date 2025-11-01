require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, EndBehaviorType } = require('@discordjs/voice');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('fluent-ffmpeg');
const prism = require('prism-media');
const { exec } = require('child_process');
const path = require('path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');

let connection = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// New global variable
let db = null;
let memoryKeywords = new Set(); // Store all memory keywords for quick lookup
let currentSessionId = null;

// Call the command registration script
exec(`node ${path.join(__dirname, 'registerCommands.js')}`, (error, stdout, stderr) => {
  if (error) {
    logToConsole(`Error registering commands: ${error.message}`, 'error', 1);
    return;
  }
  if (stderr) {
    logToConsole(`Error output: ${stderr}`, 'error', 1);
    return;
  }
  logToConsole(`Command registration output: ${stdout}`, 'info', 2);
});

const TOKEN = process.env.DISCORD_TOKEN;
const botnames = process.env.BOT_TRIGGERS.split(',');
if (!Array.isArray(botnames)) {
  logToConsole('BOT_TRIGGERS must be an array of strings', 'error', 1);
  process.exit(1);
}
logToConsole(`Bot triggers: ${botnames}`, 'info', 1);

let chatHistory = {};
let transcribemode = false;
let allowwithouttrigger = false;
let currentlythinking = false;

// ============= OPTIMIZED CONVERSATION BUFFER =============

const conversationBuffer = {
  messages: [],
  lastActivity: Date.now(),
  participants: new Set(),
  silenceTimer: null,
  isProcessing: false,
};

const CONVERSATION_CONFIG = {
  groupSilenceDuration: 3000, // 3 seconds of silence from ALL users before processing
  maxBufferSize: 10, // Maximum messages to buffer before forcing processing
  minMessagesForGroup: 2, // Minimum messages needed to trigger group conversation mode
};

// Create the directories if they don't exist
if (!fs.existsSync('./recordings')) {
  fs.mkdirSync('./recordings');
}
if (!fs.existsSync('./sounds')) {
  fs.mkdirSync('./sounds');
}
if (!fs.existsSync('./chat_logs')) {
  fs.mkdirSync('./chat_logs');
}

// ============= TOOL DEFINITIONS =============
const AVAILABLE_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web and return current information, news, facts, or events. You must formulate your own search query based on the user's message. Use this when you need up-to-date information or when the user asks about recent events.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query. Be specific and clear. Formulate this based on what the user is asking about."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_webpage",
      description: "Search a specific webpage or domain for information. Provide the whole URL if possible, otherwise provide just the domain.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to look for on the webpage"
          },
          webpage: {
            type: "string",
            description: "The URL or domain to search (e.g., 'reddit.com' or 'https://example.com')"
          }
        },
        required: ["query", "webpage"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getDateTime",
      description: "Get the current date and time in your local timezone. Use this when the user asks what time it is, what day it is, or the current date.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Perform mathematical calculations. Supports basic arithmetic (+, -, *, /, ^, %), functions like sin, cos, tan, sqrt, log, and constants like pi and e. Examples: '2 + 2', 'sqrt(16)', 'sin(pi/2)', '15% of 200'",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "The mathematical expression to evaluate. Examples: '2+2', 'sqrt(144)', '(5*9)+3'"
          }
        },
        required: ["expression"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "convert_units",
      description: "Convert between different units of measurement. Supports temperature (fahrenheit/celsius), length (miles/km, feet/meters, inches/cm), weight (pounds/kg, ounces/grams), and volume (gallons/liters, cups/ml). Use underscores and 'to' format like 'fahrenheit_to_celsius' or shorthand like 'f_to_c', 'miles_to_km', 'lbs_to_kg'.",
      parameters: {
        type: "object",
        properties: {
          value: {
            type: "number",
            description: "The numerical value to convert"
          },
          conversion: {
            type: "string",
            description: "The conversion type in format 'from_to_to'. Examples: 'fahrenheit_to_celsius', 'miles_to_kilometers', 'pounds_to_kilograms', or shorthand: 'f_to_c', 'miles_to_km', 'lbs_to_kg'"
          }
        },
        required: ["value", "conversion"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "roll_dice",
      description: "Roll virtual RPG dice. Use standard dice notation like '2d6' (roll 2 six-sided dice), '1d20' (roll 1 twenty-sided die), '3d10' (roll 3 ten-sided dice). Common dice: d4, d6, d8, d10, d12, d20, d100.",
      parameters: {
        type: "object",
        properties: {
          dice_expression: {
            type: "string",
            description: "The dice expression in XdY format, where X is the number of dice and Y is the number of sides. Examples: '2d6', '1d20', '4d8'"
          }
        },
        required: ["dice_expression"]
      }
    }
  }
];

// Tools API endpoint
const TOOLS_API_ENDPOINT = process.env.TOOLS_ENDPOINT || 'http://localhost:5001';

// ============= TOOL EXECUTION FUNCTIONS =============

async function executeSearchWeb(query) {
  try {
    logToConsole(`> [TOOL] Web Search: "${query}"`, 'info', 1);
    
    const response = await axios.post(`${TOOLS_API_ENDPOINT}/tools/search_web`, {
      query: query
    }, {
      timeout: 60000 // 60 second timeout for web searches
    });
    
    if (response.data.success) {
      const result = response.data.result;
      logToConsole(`> [TOOL] Search completed (${result.length} chars)`, 'info', 2);
      return result;
    } else {
      logToConsole(`X [TOOL] Search failed: ${response.data.error}`, 'error', 1);
      return `Web search error: ${response.data.error}`;
    }
    
  } catch (error) {
    logToConsole(`X [TOOL] Web search error: ${error.message}`, 'error', 1);
    if (error.code === 'ECONNREFUSED') {
      return `Error: Tools API server is not running. Please start it with: python ToolsAPI.py`;
    }
    return `Error performing web search: ${error.message}`;
  }
}

async function executeSearchWebpage(query, webpage) {
  try {
    logToConsole(`> [TOOL] Searching webpage "${webpage}" for: "${query}"`, 'info', 1);
    
    const response = await axios.post(`${TOOLS_API_ENDPOINT}/tools/search_webpage`, {
      query: query,
      webpage: webpage
    }, {
      timeout: 60000
    });
    
    if (response.data.success) {
      const result = response.data.result;
      logToConsole(`> [TOOL] Webpage search completed`, 'info', 2);
      return result;
    } else {
      logToConsole(`X [TOOL] Webpage search failed: ${response.data.error}`, 'error', 1);
      return `Webpage search error: ${response.data.error}`;
    }
    
  } catch (error) {
    logToConsole(`X [TOOL] Webpage search error: ${error.message}`, 'error', 1);
    if (error.code === 'ECONNREFUSED') {
      return `Error: Tools API server is not running. Please start it with: python ToolsAPI.py`;
    }
    return `Error searching webpage: ${error.message}`;
  }
}

async function executeGetDateTime() {
  try {
    logToConsole(`> [TOOL] Getting current date/time`, 'info', 1);
    
    const response = await axios.get(`${TOOLS_API_ENDPOINT}/tools/getDateTime`, {
      timeout: 5000
    });
    
    if (response.data.success) {
      const result = response.data.result;
      logToConsole(`> [TOOL] DateTime: ${result}`, 'info', 2);
      return result;
    } else {
      logToConsole(`X [TOOL] DateTime failed: ${response.data.error}`, 'error', 1);
      return `DateTime error: ${response.data.error}`;
    }
    
  } catch (error) {
    logToConsole(`X [TOOL] DateTime error: ${error.message}`, 'error', 1);
    if (error.code === 'ECONNREFUSED') {
      return `Error: Tools API server is not running. Please start it with: python ToolsAPI.py`;
    }
    // Fallback to local time if API fails
    const now = new Date();
    const result = now.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    return `The current date and time is: ${result}`;
  }
}

async function executeCalculate(expression) {
  try {
    logToConsole(`> [TOOL] Calculate: "${expression}"`, 'info', 1);
    
    const response = await axios.post(`${TOOLS_API_ENDPOINT}/tools/calculate`, {
      expression: expression
    }, {
      timeout: 5000
    });
    
    if (response.data.success) {
      const result = response.data.result;
      logToConsole(`> [TOOL] Calculation result: ${result}`, 'info', 2);
      return result;
    } else {
      logToConsole(`X [TOOL] Calculation failed: ${response.data.error}`, 'error', 1);
      return `Calculation error: ${response.data.error}`;
    }
    
  } catch (error) {
    logToConsole(`X [TOOL] Calculation error: ${error.message}`, 'error', 1);
    if (error.code === 'ECONNREFUSED') {
      return `Error: Tools API server is not running. Please start it with: python ToolsAPI.py`;
    }
    return `Error performing calculation: ${error.message}`;
  }
}

async function executeConvertUnits(value, conversion) {
  try {
    logToConsole(`> [TOOL] Convert: ${value} ${conversion}`, 'info', 1);
    
    const response = await axios.post(`${TOOLS_API_ENDPOINT}/tools/convert_units`, {
      value: value,
      conversion: conversion
    }, {
      timeout: 5000
    });
    
    if (response.data.success) {
      const result = response.data.result;
      logToConsole(`> [TOOL] Conversion result: ${result}`, 'info', 2);
      return result;
    } else {
      logToConsole(`X [TOOL] Conversion failed: ${response.data.error}`, 'error', 1);
      return `Unit conversion error: ${response.data.error}`;
    }
    
  } catch (error) {
    logToConsole(`X [TOOL] Conversion error: ${error.message}`, 'error', 1);
    if (error.code === 'ECONNREFUSED') {
      return `Error: Tools API server is not running. Please start it with: python ToolsAPI.py`;
    }
    return `Error converting units: ${error.message}`;
  }
}

async function executeRollDice(diceExpression) {
  try {
    logToConsole(`> [TOOL] Roll Dice: "${diceExpression}"`, 'info', 1);
    
    const response = await axios.post(`${TOOLS_API_ENDPOINT}/tools/roll_dice`, {
      dice_expression: diceExpression
    }, {
      timeout: 5000
    });
    
    if (response.data.success) {
      const result = response.data.result;
      logToConsole(`> [TOOL] Dice roll result: ${result}`, 'info', 2);
      return result;
    } else {
      logToConsole(`X [TOOL] Dice roll failed: ${response.data.error}`, 'error', 1);
      return `Dice roll error: ${response.data.error}`;
    }
    
  } catch (error) {
    logToConsole(`X [TOOL] Dice roll error: ${error.message}`, 'error', 1);
    if (error.code === 'ECONNREFUSED') {
      return `Error: Tools API server is not running. Please start it with: python ToolsAPI.py`;
    }
    return `Error rolling dice: ${error.message}`;
  }
}

async function executeTool(toolName, argsString) {
  try {
    const args = argsString ? JSON.parse(argsString) : {};
    logToConsole(`> [TOOL] Executing: ${toolName}`, 'info', 1);
    logToConsole(`> [TOOL] Arguments: ${JSON.stringify(args)}`, 'info', 2);
    
    let result;
    switch(toolName) {
      case 'search_web':
        result = await executeSearchWeb(args.query);
        break;
      
      case 'search_webpage':
        result = await executeSearchWebpage(args.query, args.webpage);
        break;
      
      case 'getDateTime':
        result = await executeGetDateTime();
        break;
      
      case 'calculate':
        result = await executeCalculate(args.expression);
        break;
      
      case 'convert_units':
        result = await executeConvertUnits(args.value, args.conversion);
        break;
      
      case 'roll_dice':
        result = await executeRollDice(args.dice_expression);
        break;
      
      default:
        result = `Unknown tool: ${toolName}`;
        logToConsole(`X [TOOL] Unknown tool requested: ${toolName}`, 'error', 1);
    }
    
    return result;
  } catch (error) {
    logToConsole(`X [TOOL] Execution error: ${error.message}`, 'error', 1);
    logToConsole(`X [TOOL] Stack: ${error.stack}`, 'error', 2);
    return `Tool execution error: ${error.message}`;
  }
}

// ============= END TOOL DEFINITIONS =============

client.on('clientReady', async () => {
  // Initialize database (this generates the first session ID)
  await initializeDatabase();
  
  // Clean up any old recordings
  fs.readdir('./recordings', (err, files) => {
    if (err) {
      logToConsole('Error reading recordings directory', 'error', 1);
      return;
    }

    files.forEach(file => {
      fs.unlinkSync(`./recordings/${file}`);
    });
  });

  logToConsole(`Logged in as ${client.user.tag}! Session ID: ${currentSessionId}`, 'info', 1);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  const { commandName, options } = interaction;

  switch (commandName) {
    case 'join':
      const mode = options.getString('mode');
      // Your join logic here, using `mode` as the option
      if (connection) {
        await interaction.reply({ content: 'I am already in a voice channel. Please use the `leave` command first.', ephemeral: true });
        return;
      }

      // Generate new session ID when joining voice chat
      currentSessionId = generateSessionId();
      logToConsole(`Started new voice session: ${currentSessionId}`, 'info', 1);

      allowwithouttrigger = false;
      transcribemode = false;

        if (mode === 'free') {
        allowwithouttrigger = true;
      } else if (mode === 'transcribe') {
        transcribemode = true;
      }

      if (interaction.member.voice.channel) {
        connection = joinVoiceChannel({
          channelId: interaction.member.voice.channel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
          selfDeaf: false,
        });
        if (transcribemode) {
          sendToTTS('Transcription mode is enabled for this conversation. Once you type the leave command, a transcription of the conversation will be sent in the channel.', interaction.user.id, connection, interaction.member.voice.channel);
        }
        logToConsole('> Joined voice channel', 'info', 1);
        handleRecording(connection, interaction.member.voice.channel);
        await interaction.reply({ content: 'Joined voice channel.', ephemeral: true });
      } else {
        await interaction.reply({ content: 'You need to join a voice channel first!', ephemeral: true });
      }
      break;

    case 'reset':
      chatHistory = {};
      await interaction.reply({ content: 'Chat history reset!', ephemeral: true });
      logToConsole('> Chat history reset!', 'info', 1);
      break;

    
    case 'leave':
      if (connection) {
        logToConsole(`Ending voice session: ${currentSessionId}`, 'info', 1);
        connection.destroy();
        audioqueue = [];

        if (transcribemode) {
          await interaction.reply({ files: ['./transcription.txt'] }).then(() => {
            fs.unlinkSync('./transcription.txt');
          });
        }

        connection = null;
        chatHistory = {};
        logToConsole('> Left voice channel', 'info', 1);
        
        
        await interaction.reply({ content: 'Left voice channel.', ephemeral: true });
      } else {
        await interaction.reply({ content: 'I am not in a voice channel.', ephemeral: true });
      }
      break;
    
    case 'help':
      await interaction.reply({ content: `Commands: \n
      \`/join\` - Join voice channel and start listening for trigger words.
      \`/join free\` - Join voice channel and listen without trigger words.
      \`/join transcribe\` - Join voice channel and save the conversation to a file which will be sent when using \`/leave\` command.
      \`/reset\` - Reset chat history. You may also say \`reset chat history\` in voice chat.
      \`/leave\` - Leave voice channel. You may also say \`leave voice chat\` in voice chat.
      \`/help\` - Display this message.`, ephemeral: true });
      break;
  }
});

// If bot is in voice channel and a user joins, start listening to them (except for itself)
client.on('voiceStateUpdate', (oldState, newState) => {
  // Check if the user has joined a new channel (and it's the specific channel the bot is in)
  // and ensure the user is not the bot itself
  if (connection &&
      oldState.channelId !== newState.channelId &&
      newState.channelId === connection.joinConfig.channelId &&
      newState.member.user.id !== client.user.id) {
    // Additional check to ensure the user is not just unmuting/muting or performing other state changes
    if (newState.channelId !== null) { // User has joined the channel (not just updated their state in the same channel)
      logToConsole(`> User joined voice channel: ${newState.member.user.username}`, 'info', 1);
      handleRecordingForUser(newState.member.user.id, connection, newState.channel);
    }
  }
});

async function initializeDatabase() {
  try {
    // Only initialize database if chat logging or memory system is enabled
    const chatLogEnabled = process.env.CHAT_LOG !== "false";
    const memoryEnabled = process.env.MEMORY_SYSTEM !== "false";
    
    if (!chatLogEnabled && !memoryEnabled) {
      logToConsole('Both chat logging and memory system are disabled, skipping database initialization', 'info', 1);
      currentSessionId = generateSessionId();
      return;
    }

    db = await open({
      filename: './chat_logs/chat_history.db',
      driver: sqlite3.Database
    });

    // Create tables based on what's enabled
    let tableCreation = '';
    
    if (chatLogEnabled) {
      tableCreation += `
        CREATE TABLE IF NOT EXISTS chat_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          user_message TEXT NOT NULL,
          ai_response TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          date_only TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_id ON chat_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_date ON chat_logs(date_only);
        CREATE INDEX IF NOT EXISTS idx_timestamp ON chat_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_session_id ON chat_logs(session_id);
      `;
    }
    
    if (memoryEnabled) {
      tableCreation += `
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          keywords TEXT NOT NULL,
          summary TEXT NOT NULL,
          content TEXT NOT NULL,
          memory_type TEXT DEFAULT 'general',
          importance_score INTEGER DEFAULT 5,
          timestamp TEXT NOT NULL,
          access_count INTEGER DEFAULT 0,
          last_accessed TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_user_id ON memories(user_id);
        CREATE INDEX IF NOT EXISTS idx_memory_keywords ON memories(keywords);
        CREATE INDEX IF NOT EXISTS idx_memory_type ON memories(memory_type);
        CREATE INDEX IF NOT EXISTS idx_memory_session_id ON memories(session_id);
      `;
    }

    await db.exec(tableCreation);

    // Generate initial session ID
    currentSessionId = generateSessionId();
    
    // Load memory keywords only if memory system is enabled
    if (memoryEnabled) {
      await loadMemoryKeywords();
    }

    logToConsole(`Database initialized successfully with session ID: ${currentSessionId}`, 'info', 1);
  } catch (error) {
    logToConsole(`Error initializing database: ${error.message}`, 'error', 1);
  }
}

function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// ==== MEMORY FUNCTIONS ====
async function loadMemoryKeywords() {
  if (!db) return;
  
  try {
    const memories = await db.all(`SELECT keywords FROM memories`);
    memoryKeywords.clear();
    
    memories.forEach(memory => {
      const keywords = memory.keywords.split(',').map(k => k.trim().toLowerCase());
      keywords.forEach(keyword => memoryKeywords.add(keyword));
    });
    
    logToConsole(`Loaded ${memoryKeywords.size} memory keywords`, 'info', 2);
  } catch (error) {
    logToConsole(`Error loading memory keywords: ${error.message}`, 'error', 1);
  }
}

async function saveMemory(userId, keywords, summary, content, memoryType = 'general', importanceScore = 5) {
  if (process.env.MEMORY_SYSTEM === "false" || process.env.MEMORY_SYSTEM === false) {
    logToConsole('> Memory system is disabled', 'info', 2);
    return false;
  }
  
  logToConsole(`> [MEMORY SAVE] User: ${userId}, Session: ${currentSessionId}`, 'info', 1);
  logToConsole(`> [MEMORY SAVE] DB Status: ${db ? 'Connected' : 'NULL'}`, db ? 'info' : 'error', 1);
  
  if (!db) {
    logToConsole('X [MEMORY SAVE] Database not initialized', 'error', 1);
    return false;
  }
  
  if (!currentSessionId) {
    logToConsole('X [MEMORY SAVE] No current session ID', 'error', 1);
    return false;
  }

  try {
    const timestamp = new Date().toISOString();
    const keywordString = Array.isArray(keywords) ? keywords.join(', ') : keywords;
    
    logToConsole(`> [MEMORY SAVE] Keywords: "${keywordString}"`, 'info', 1);
    logToConsole(`> [MEMORY SAVE] Summary: "${summary}"`, 'info', 1);
    
    const result = await db.run(`
      INSERT INTO memories (user_id, session_id, keywords, summary, content, memory_type, importance_score, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [userId, currentSessionId, keywordString, summary, content, memoryType, importanceScore, timestamp]);

    logToConsole(`> [MEMORY SAVE] SUCCESS - ID: ${result.lastID}`, 'info', 1);

    // Update keyword set
    const keywordArray = keywordString.split(',').map(k => k.trim().toLowerCase());
    keywordArray.forEach(keyword => memoryKeywords.add(keyword));

    return true;
  } catch (error) {
    logToConsole(`X [MEMORY SAVE] ERROR: ${error.message}`, 'error', 1);
    return false;
  }
}

async function findMemoriesByKeywords(userId, keywords, limit = 5) {
  if (process.env.MEMORY_SYSTEM === "false" || process.env.MEMORY_SYSTEM === false) {
    return [];
  }
  
  if (!db || !currentSessionId) return [];

  try {
    const keywordArray = Array.isArray(keywords) ? keywords : keywords.split(',').map(k => k.trim());
    const searchTerms = keywordArray.map(k => `%${k.toLowerCase()}%`);
    
    // Build dynamic query based on number of keywords
    const whereConditions = searchTerms.map(() => `LOWER(keywords) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(content) LIKE ?`);
    const queryParams = [];
    
    searchTerms.forEach(term => {
      queryParams.push(term, term, term); // For keywords, summary, and content
    });
    
    // EXCLUDE memories from the current session
    const memories = await db.all(`
      SELECT id, keywords, summary, content, memory_type, importance_score, timestamp, access_count, session_id
      FROM memories 
      WHERE user_id = ? AND session_id != ? AND (${whereConditions.join(' OR ')})
      ORDER BY importance_score DESC, access_count DESC, timestamp DESC
      LIMIT ?
    `, [userId, currentSessionId, ...queryParams, limit]);

    // Update access count for retrieved memories
    for (const memory of memories) {
      await db.run(`
        UPDATE memories 
        SET access_count = access_count + 1, last_accessed = ? 
        WHERE id = ?
      `, [new Date().toISOString(), memory.id]);
    }

    logToConsole(`Found ${memories.length} memories from previous sessions for user ${userId}`, 'info', 2);
    return memories;
  } catch (error) {
    logToConsole(`Error finding memories: ${error.message}`, 'error', 1);
    return [];
  }
}

async function findMemoryById(userId, memoryId) {
  if (!db) return null;

  try {
    const memory = await db.get(`
      SELECT * FROM memories 
      WHERE id = ? AND user_id = ?
    `, [memoryId, userId]);

    return memory;
  } catch (error) {
    logToConsole(`Error finding memory by ID: ${error.message}`, 'error', 1);
    return null;
  }
}

async function updateMemory(userId, memoryId, updates) {
  if (!db) return false;

  try {
    const setParts = [];
    const values = [];
    
    if (updates.keywords) {
      setParts.push('keywords = ?');
      values.push(Array.isArray(updates.keywords) ? updates.keywords.join(', ') : updates.keywords);
    }
    if (updates.summary) {
      setParts.push('summary = ?');
      values.push(updates.summary);
    }
    if (updates.content) {
      setParts.push('content = ?');
      values.push(updates.content);
    }
    if (updates.importance_score) {
      setParts.push('importance_score = ?');
      values.push(updates.importance_score);
    }

    if (setParts.length === 0) return false;

    values.push(userId, memoryId);

    await db.run(`
      UPDATE memories 
      SET ${setParts.join(', ')} 
      WHERE user_id = ? AND id = ?
    `, values);

    // Reload keywords if they were updated
    if (updates.keywords) {
      await loadMemoryKeywords();
    }

    logToConsole(`Memory ${memoryId} updated for user ${userId}`, 'info', 1);
    return true;
  } catch (error) {
    logToConsole(`Error updating memory: ${error.message}`, 'error', 1);
    return false;
  }
}

async function deleteMemory(userId, memoryId) {
  if (!db) return false;

  try {
    const result = await db.run(`
      DELETE FROM memories 
      WHERE id = ? AND user_id = ?
    `, [memoryId, userId]);

    if (result.changes > 0) {
      // Reload keywords after deletion
      await loadMemoryKeywords();
      logToConsole(`Memory ${memoryId} deleted for user ${userId}`, 'info', 1);
      return true;
    }
    
    return false;
  } catch (error) {
    logToConsole(`Error deleting memory: ${error.message}`, 'error', 1);
    return false;
  }
}

function checkForMemoryKeywords(text) {
  if (process.env.MEMORY_SYSTEM === "false" || process.env.MEMORY_SYSTEM === false) {
    return [];
  }
  
  const words = text.toLowerCase().split(/\s+/);
  const foundKeywords = [];
  
  words.forEach(word => {
    // Remove punctuation
    const cleanWord = word.replace(/[^\w]/g, '');
    if (memoryKeywords.has(cleanWord)) {
      foundKeywords.push(cleanWord);
    }
  });
  
  return foundKeywords;
}

async function parseMemoryTags(response, userId) {
  if (process.env.MEMORY_SYSTEM === "false" || process.env.MEMORY_SYSTEM === false) {
    logToConsole('> Memory system is disabled, skipping memory tag parsing', 'info', 2);
    // Still need to remove the tags from the response
    const memoryRegex = /<memories>([\s\S]*?)<\/memories>/g;
    return response.replace(memoryRegex, '').trim();
  }
  
  logToConsole(`> Parsing memory tags for user ${userId}, session: ${currentSessionId}`, 'info', 1);
  
  const memoryRegex = /<memories>([\s\S]*?)<\/memories>/g;
  const matches = [...response.matchAll(memoryRegex)];
  
  logToConsole(`> Found ${matches.length} memory tags`, 'info', 1);
  
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const memoryContent = match[1].trim();
    logToConsole(`> Memory tag ${i + 1} raw content: "${memoryContent}"`, 'info', 1);
    
    // Handle both formats: comma-separated AND newline-separated
    let parts = [];
    
    // Try comma-separated format first
    if (memoryContent.includes(',') && !memoryContent.includes('\n')) {
      // Single line comma-separated format
      parts = memoryContent.split(',').map(part => part.trim()).filter(part => part.length > 0);
      logToConsole(`> Parsed as comma-separated: ${JSON.stringify(parts)}`, 'info', 2);
    } else {
      // Multi-line format (original)
      parts = memoryContent.split('\n').map(line => line.trim()).filter(line => line.length > 0);
      logToConsole(`> Parsed as multi-line: ${JSON.stringify(parts)}`, 'info', 2);
    }
    
    if (parts.length < 2) {
      logToConsole(`> Skipping memory ${i + 1}: insufficient parts (need at least 2)`, 'warn', 1);
      continue;
    }
    
    // Check if this is a modification/deletion command
    if (parts[0].toLowerCase().startsWith('modify/') || parts[0].toLowerCase().startsWith('delete/')) {
      logToConsole(`> Processing memory command: ${parts[0]}`, 'info', 1);
      await handleMemoryCommand(parts, userId);
    } else {
      // Regular memory storage
      const keywords = parts[0];
      const summary = parts[1];
      const content = parts.length > 2 ? parts.slice(2).join(' ') : summary;
      
      logToConsole(`> Saving memory - Keywords: "${keywords}", Summary: "${summary}"`, 'info', 1);
      const success = await saveMemory(userId, keywords, summary, content);
      logToConsole(`> Memory save result: ${success ? 'SUCCESS' : 'FAILED'}`, success ? 'info' : 'error', 1);
    }
  }
  
  // Remove memory tags from response
  const cleanedResponse = response.replace(memoryRegex, '').trim();
  return cleanedResponse;
}

async function handleMemoryCommand(lines, userId) {
  const command = lines[0].toLowerCase();
  
  if (command.startsWith('modify/')) {
    // Extract memory identifier from the command
    const identifier = command.replace('modify/', '').trim();
    const newSummary = lines[1];
    const newContent = lines.slice(2).join('\n') || newSummary;
    
    // Find memory by ID or by searching keywords/summary
    let memory = null;
    const memoryId = parseInt(identifier);
    
    if (!isNaN(memoryId)) {
      memory = await findMemoryById(userId, memoryId);
    } else {
      // Search by keywords/summary
      const foundMemories = await findMemoriesByKeywords(userId, identifier, 1);
      if (foundMemories.length > 0) {
        memory = foundMemories[0];
      }
    }
    
    if (memory) {
      await updateMemory(userId, memory.id, {
        summary: newSummary,
        content: newContent
      });
    }
  } else if (command.startsWith('delete/')) {
    // Extract memory identifier
    const identifier = command.replace('delete/', '').trim();
    
    let memory = null;
    const memoryId = parseInt(identifier);
    
    if (!isNaN(memoryId)) {
      memory = await findMemoryById(userId, memoryId);
    } else {
      // Search by keywords/summary
      const foundMemories = await findMemoriesByKeywords(userId, identifier, 1);
      if (foundMemories.length > 0) {
        memory = foundMemories[0];
      }
    }
    
    if (memory) {
      await deleteMemory(userId, memory.id);
    }
  }
}

function formatMemoriesForContext(memories) {
  if (memories.length === 0) return "";
  
  let formatted = "=== RELEVANT MEMORIES ===\n";
  memories.forEach((memory, index) => {
    const date = new Date(memory.timestamp).toLocaleDateString();
    formatted += `${index + 1}. ${memory.summary} (${date}, accessed ${memory.access_count}x)\n`;
    if (memory.content !== memory.summary && memory.content.length < 200) {
      formatted += `   Details: ${memory.content}\n`;
    }
  });
  formatted += "=== END MEMORIES ===\n\n";
  
  return formatted;
}

function getMemorySystemPrompt() {
  if (process.env.MEMORY_SYSTEM === "false" || process.env.MEMORY_SYSTEM === false) {
    return ""; // Return empty string if disabled
  }
  
  return `
=== MEMORY SYSTEM INSTRUCTIONS === Memories are separate from Recent Conversation History. During conversations or when you meet a new person, you should consider storing or modifying memories by utilizing one of the three formats listed. Add a new memory: <memories>[ keywords: words, separated, by, commas, go, here ],[ Brief summary of what to remember ],[ Optional: Relevant conversation excerpts or more detailed content or leave this blank ]</memories> You can also modify existing memories: <memories>modify/[ memory ID or a keyword accociated with memory ],[ New summary ],[ New detailed content ]</memories> Or you can delete outdated memories: <memories>delete/[ memory ID or a keyword accociated with memory ]</memories> Guidelines: Store memories about: user preferences, important facts, interesting topics. Keep summaries concise but informative. Keywords are triggered by users, and will automatically remind you of your memory in a later conversation. Use clear keywords that you think a user might say in the future within the same or similar context. Update or delete memories that become outdated or incorrect. Memory System formats should be added after your response and will not be visible to users. === END MEMORY INSTRUCTIONS ===
`;
}

// Chat logging functions - Add these after your existing variables
async function saveChatLog(userId, userMessage, aiResponse, channel) {
  if (process.env.CHAT_LOG === "false" || process.env.CHAT_LOG === false) {
    logToConsole('> Chat logging is disabled', 'info', 2);
    return;
  }
  
  if (!db) {
    logToConsole('Database not initialized', 'error', 1);
    return;
  }

  if (!currentSessionId) {
    logToConsole('No current session ID', 'error', 1);
    return;
  }

  try {
    const displayName = getDisplayName(userId, channel);
    const timestamp = new Date().toISOString();
    const dateOnly = timestamp.split('T')[0];

    await db.run(`
      INSERT INTO chat_logs (user_id, session_id, display_name, user_message, ai_response, timestamp, date_only)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [userId, currentSessionId, displayName, userMessage, aiResponse, timestamp, dateOnly]);

    logToConsole(`Chat log saved for user ${userId} in session ${currentSessionId}`, 'info', 2);
  } catch (error) {
    logToConsole(`Error saving chat log: ${error.message}`, 'error', 1);
  }
}

async function getRecentChatLogs(userId, days = 7, maxEntries = 50) {
  if (process.env.CHAT_LOG === "false" || process.env.CHAT_LOG === false) {
    return [];
  }
  
  if (!db) {
    logToConsole('Database not initialized', 'error', 1);
    return [];
  }

  if (!currentSessionId) {
    logToConsole('No current session ID', 'error', 1);
    return [];
  }

  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffDateString = cutoffDate.toISOString().split('T')[0];

    // EXCLUDE current session, just like memories do
    const logs = await db.all(`
      SELECT display_name, user_message, ai_response, timestamp, session_id
      FROM chat_logs
      WHERE user_id = ? AND session_id != ? AND date_only >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `, [userId, currentSessionId, cutoffDateString, maxEntries]);

    // Reverse to get chronological order (oldest first)
    return logs.reverse();
  } catch (error) {
    logToConsole(`Error retrieving chat logs: ${error.message}`, 'error', 1);
    return [];
  }
}

function formatChatLogsForContext(logs) {
  if (logs.length === 0) return "";
  
  let formattedLogs = "=== RECENT CONVERSATION HISTORY ===\n";
  
  logs.forEach((log, index) => {
    const date = new Date(log.timestamp).toLocaleDateString();
    const time = new Date(log.timestamp).toLocaleTimeString();
    const name = log.display_name || `User ${log.user_id}`;
    formattedLogs += `[${date} ${time}]\n`;
    formattedLogs += `${name}: ${log.user_message}\n`;
    formattedLogs += `Assistant: ${log.ai_response}\n\n`;
  });
  
  formattedLogs += "=== END HISTORY ===\n\n";
  return formattedLogs;
}

function handleRecording(connection, channel) {
  const receiver = connection.receiver;
  
  channel.members.forEach(member => {
    if (member.user.bot) return;
    setupUserListener(member.user.id, receiver, connection, channel);
  });
}

function setupUserListener(userId, receiver, connection, channel) {
  const filePath = `./recordings/${userId}.pcm`;
  const writeStream = fs.createWriteStream(filePath);
  
  const listenStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: process.env.WAIT_TIME,
    },
  });

  const opusDecoder = new prism.opus.Decoder({
    frameSize: 960,
    channels: 1,
    rate: 48000,
  });

  listenStream.pipe(opusDecoder).pipe(writeStream);

  writeStream.on('finish', () => {
    logToConsole(`> Audio recorded for ${userId}`, 'info', 2);
    convertAndHandleFile(filePath, userId, connection, channel);
  });
}

function handleRecordingForUser(userID, connection, channel) {
  const receiver = connection.receiver;

  const filePath = `./recordings/${userID}.pcm`;
  const writeStream = fs.createWriteStream(filePath);
  const listenStream = receiver.subscribe(userID, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: process.env.WAIT_TIME,
    },
  });

  const opusDecoder = new prism.opus.Decoder({
    frameSize: 960,
    channels: 1,
    rate: 48000,
  });

  listenStream.pipe(opusDecoder).pipe(writeStream);

  writeStream.on('finish', () => {
    logToConsole(`> Audio recorded for ${userID}`, 'info', 2);
    convertAndHandleFile(filePath, userID, connection, channel);
  });
}

function convertAndHandleFile(filePath, userId, connection, channel) {
  const mp3Path = filePath.replace('.pcm', '.mp3');
  
  ffmpeg(filePath)
    .inputFormat('s16le')
    .audioChannels(1)
    .format('mp3')
    .on('error', (err) => {
      logToConsole(`X Error converting file: ${err.message}`, 'error', 1);
      currentlythinking = false;
    })
    .save(mp3Path)
    .on('end', () => {
      logToConsole(`> Converted to MP3: ${mp3Path}`, 'info', 2);
      sendAudioToAPI(mp3Path, userId, connection, channel);
    });
}

// ============= CONVERSATION BUFFER DECISION LOGIC =============
async function shouldProcessConversationBuffer() {
  // Force process if buffer is full
  if (conversationBuffer.messages.length >= CONVERSATION_CONFIG.maxBufferSize) {
    logToConsole('> Buffer full, forcing conversation processing', 'info', 1);
    return true;
  }
  
  // Check if bot was directly addressed in latest message
  const latestMessage = conversationBuffer.messages[conversationBuffer.messages.length - 1];
  const hasTrigger = botnames.some(name => {
    const regex = new RegExp(`\\b${name}\\b`, 'i');
    return regex.test(latestMessage.transcription) || allowwithouttrigger;
  });
  
  if (hasTrigger) {
    logToConsole('> Bot was addressed, processing immediately', 'info', 1);
    return true;
  }
  
  // If only one person speaking, process immediately (maintain old behavior for solo users)
  if (conversationBuffer.participants.size === 1) {
    return true;
  }
  
  // For group conversations, wait for silence timer
  return false;
}

// ============= PROCESS BUFFERED CONVERSATION =============
async function processConversationBuffer(connection, channel) {
  if (conversationBuffer.isProcessing || conversationBuffer.messages.length === 0) {
    return;
  }
  
  conversationBuffer.isProcessing = true;
  currentlythinking = true;
  
  // Build conversation context
  const conversationText = conversationBuffer.messages
    .map(msg => `${msg.displayName}: ${msg.transcription}`)
    .join('\n');
  
  logToConsole(`> Processing buffered conversation (${conversationBuffer.messages.length} messages from ${conversationBuffer.participants.size} users)`, 'info', 1);
  logToConsole(`> Conversation:\n${conversationText}`, 'info', 2);
  
  // Determine primary user for chat history (use last speaker or most active)
  const userMessageCounts = {};
  conversationBuffer.messages.forEach(msg => {
    userMessageCounts[msg.userId] = (userMessageCounts[msg.userId] || 0) + 1;
  });
  const primaryUserId = Object.keys(userMessageCounts).reduce((a, b) => 
    userMessageCounts[a] > userMessageCounts[b] ? a : b
  );
  
  // Check for commands
  const lowerConversation = conversationText.toLowerCase();
  if (lowerConversation.includes("reset") && lowerConversation.includes("chat") && lowerConversation.includes("history")) {
    chatHistory = {};
    logToConsole('> Chat history reset!', 'info', 1);
    clearConversationBuffer();
    currentlythinking = false;
    return;
  } else if (lowerConversation.includes("leave") && lowerConversation.includes("voice") && lowerConversation.includes("chat")) {
    connection.destroy();
    connection = null;
    chatHistory = {};
    logToConsole('> Left voice channel', 'info', 1);
    clearConversationBuffer();
    currentlythinking = false;
    return;
  }
  
  // Send to LLM with optimized context
  await sendToLLM(conversationText, primaryUserId, conversationBuffer.participants, connection, channel);
  
  // Clear buffer after processing
  clearConversationBuffer();
  currentlythinking = false;
}

function clearConversationBuffer() {
  conversationBuffer.messages = [];
  conversationBuffer.participants.clear();
  conversationBuffer.isProcessing = false;
  if (conversationBuffer.silenceTimer) {
    clearTimeout(conversationBuffer.silenceTimer);
    conversationBuffer.silenceTimer = null;
  }
}

async function sendAudioToAPI(fileName, userId, connection, channel) {
  // Check if bot is currently thinking
  if (currentlythinking) {
    logToConsole('> Bot is currently thinking, skipping this audio input...', 'info', 2);
    // Cleanup files
    try {
      fs.unlinkSync(fileName);
      const pcmPath = fileName.replace('.mp3', '.pcm');
      fs.unlinkSync(pcmPath);
    } catch (cleanupError) {
      // Silent fail on cleanup
    }
    restartListening(userId, connection, channel);
    return;
  }

  const formData = new FormData();
  formData.append('model', process.env.STT_MODEL);
  formData.append('file', fs.createReadStream(fileName));

  try {
    const response = await axios.post(
      process.env.STT_ENDPOINT + '/v1/audio/transcriptions',
      formData,
      { headers: { ...formData.getHeaders() } }
    );
    
    let transcription = cleanTranscription(response.data.text);
    
    // Ignore background noise triggers
    const ignoreTriggers = ['Thank you.', 'Bye.'];
    if (ignoreTriggers.some(trigger => transcription.includes(trigger))) {
      logToConsole('> Ignoring background/keyboard sounds.', 'info', 2);
      restartListening(userId, connection, channel);
      return;
    }

    logToConsole(`> Transcription for ${userId}: "${transcription}"`, 'info', 1);
    
    // Add to conversation buffer
    const displayName = getDisplayName(userId, channel);
    conversationBuffer.messages.push({
      userId,
      displayName,
      transcription,
      timestamp: Date.now(),
    });
    conversationBuffer.participants.add(userId);
    conversationBuffer.lastActivity = Date.now();
    
    // Clear existing silence timer
    if (conversationBuffer.silenceTimer) {
      clearTimeout(conversationBuffer.silenceTimer);
    }
    
    // Check if we should process immediately or wait for more messages
    const shouldProcessNow = await shouldProcessConversationBuffer();
    
    if (shouldProcessNow) {
      await processConversationBuffer(connection, channel);
    } else {
      // Set new silence timer
      conversationBuffer.silenceTimer = setTimeout(() => {
        processConversationBuffer(connection, channel);
      }, CONVERSATION_CONFIG.groupSilenceDuration);
    }
    
    // Restart listening for this user
    restartListening(userId, connection, channel);
    
  } catch (error) {
    currentlythinking = false;
    logToConsole(`X Failed to transcribe audio: ${error.message}`, 'error', 1);
    restartListening(userId, connection, channel);
  } finally {
    // Cleanup files
    try {
      fs.unlinkSync(fileName);
      const pcmPath = fileName.replace('.mp3', '.pcm');
      fs.unlinkSync(pcmPath);
    } catch (cleanupError) {
      // Silent fail on cleanup
    }
  }
}

function estimateTokenCount(text) {
  return Math.ceil(text.length / 4); // Rough estimate: ~4 chars per token
}

function logPromptStats(systemPrompt, messages) {
  const totalTokens = estimateTokenCount(systemPrompt + JSON.stringify(messages));
  const systemTokens = estimateTokenCount(systemPrompt);
  
  logToConsole(`> Prompt stats: System=${systemTokens} tokens, Total=${totalTokens} tokens`, 'info', 2);
  
  if (totalTokens > 3000) {
    logToConsole(`! Large prompt detected: ${totalTokens} tokens`, 'warn', 1);
  }

  // Save full prompt to file (Uncomment to test system prompt)
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `./chat_logs/prompt_${timestamp}.txt`;
    
    let fullPrompt = `Timestamp: ${new Date().toLocaleString()}\n`;
    fullPrompt += `System Tokens: ${systemTokens}\n`;
    fullPrompt += `Total Tokens: ${totalTokens}\n\n`;
    fullPrompt += '=== FULL PROMPT SENT TO LLM ===\n\n';
    fullPrompt += systemPrompt;
    fullPrompt += '=== MESSAGES ===\n\n';
    fullPrompt += JSON.stringify(messages, null, 2);
    
    fs.writeFileSync(filename, fullPrompt);
    logToConsole(`> Prompt saved to ${filename}`, 'info', 2);
  } catch (error) {
    logToConsole(`X Failed to save prompt: ${error.message}`, 'error', 1);
  }
}

function getDisplayName(userId, channel) {
  const member = channel.guild.members.cache.get(userId);
  return member?.displayName || member?.user.globalName || member?.user.username || `User ${userId}`;
}

function cleanTranscription(transcription) {
  // Replace common STT misinterpretations of "Berger" with the correct name
  const replacements = {
    // Case-insensitive replacements for "Burger" variations
    'burger': 'Berger',
    'Burger': 'Berger',
    'BURGER': 'Berger',
    
    // Add other common STT mishearings of "Berger" if noticed
    'berger': 'Berger',  
    
  };

  let cleaned = transcription;
  
  // Replace each word, preserving word boundaries
  Object.entries(replacements).forEach(([incorrect, correct]) => {
    // Use word boundaries (\b) to ensure we only replace whole words
    const regex = new RegExp(`\\b${incorrect}\\b`, 'g');
    cleaned = cleaned.replace(regex, correct);
  });

  // Additional cleaning you might want to add:
  
  // Fix common STT punctuation issues
  cleaned = cleaned.replace(/\s+/g, ' '); // Remove extra spaces
  cleaned = cleaned.trim(); // Remove leading/trailing spaces
  
  return cleaned;
}

// Helper function to replace placeholders in system prompt
function processSystemPrompt(prompt) {
  const now = new Date();
  const timezone = process.env.TIMEZONE || 'America/Phoenix';
  
  const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const timeOptions = { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone };
  
  const currentDate = now.toLocaleDateString('en-US', dateOptions);
  const currentTime = now.toLocaleTimeString('en-US', timeOptions);
  const currentYear = now.getFullYear();
  
  // Replace placeholders
  return prompt
    .replace(/%DATE%/g, currentDate)
    .replace(/%TIME%/g, currentTime)
    .replace(/%YEAR%/g, currentYear)
    .replace(/%DATETIME%/g, `${currentDate} at ${currentTime}`);
}

async function sendToLLM(conversationText, primaryUserId, allParticipants, connection, channel) {
  let messages = chatHistory[primaryUserId] || [];
  
  // OPTIMIZATION 1: Smart memory retrieval - only check if keywords are present
  const conversationLower = conversationText.toLowerCase();
  const foundKeywords = checkForMemoryKeywords(conversationLower);
  let relevantMemories = [];
  
  if (foundKeywords.length > 0) {
    logToConsole(`> Found memory keywords: ${foundKeywords.join(', ')}`, 'info', 1);
    relevantMemories = await findMemoriesByKeywords(primaryUserId, foundKeywords, 3);
  }
  
  // OPTIMIZATION 2: Smart chat log retrieval - only inject if conversation is short or semantic match
  const needsHistoryContext = messages.length <= 2;
  let contextInjected = false;
  
  if (messages.length === 0) {
    let systemPrompt = allowwithouttrigger ? process.env.LLM_SYSTEM_PROMPT_FREE : process.env.LLM_SYSTEM_PROMPT;
    systemPrompt = processSystemPrompt(systemPrompt);
    
    // Build participant list
    const participantNames = Array.from(allParticipants)
      .map(id => getDisplayName(id, channel))
      .join(', ');
    
    systemPrompt += `\n\n=== USER INFORMATION ===\n`;
    if (allParticipants.size > 1) {
      systemPrompt += `You are currently in a conversation with multiple people: ${participantNames}.\n`;
      systemPrompt += `The conversation may have multiple speakers. Pay attention to who is saying what.\n\n`;
    } else {
      systemPrompt += `You are currently talking to ${participantNames}.\n\n`;
    }
    
    // Add memory system instructions
    systemPrompt += getMemorySystemPrompt();
    
    // Add relevant memories if found
    if (relevantMemories.length > 0) {
      systemPrompt += '\n' + formatMemoriesForContext(relevantMemories);
      logToConsole(`> Injected ${relevantMemories.length} relevant memories`, 'info', 1);
    }
    
    // OPTIMIZATION 3: Only inject chat history if needed
    if (needsHistoryContext) {
      const recentLogs = await getRecentChatLogs(primaryUserId, 7, 5); // Reduced from 8 to 5
      if (recentLogs.length > 0) {
        const formattedLogs = formatChatLogsForContext(recentLogs);
        systemPrompt += formattedLogs;
        contextInjected = true;
        logToConsole('> Injected chat history context', 'info', 2);
      }
    }
    
    messages.push({
      role: 'system',
      content: systemPrompt
    });
    
    logPromptStats(systemPrompt, messages);
  } else {
    // For ongoing conversations, only add memories if found
    if (relevantMemories.length > 0) {
      messages.push({
        role: 'system',
        content: `=== MEMORIES RECALLED ===\n${formatMemoriesForContext(relevantMemories)}`
      });
      logToConsole(`> Injected ${relevantMemories.length} memories into ongoing conversation`, 'info', 1);
    }
  }
  
  // Add the user's message(s) to chat history
  messages.push({
    role: 'user',
    content: conversationText
  });

  // OPTIMIZATION 4: Dynamic memory size based on context
  const effectiveMemorySize = (contextInjected || relevantMemories.length > 0) 
    ? parseInt(process.env.MEMORY_SIZE) + 2 
    : parseInt(process.env.MEMORY_SIZE);
    
  if (messages.length > effectiveMemorySize) {
    messages = messages.slice(messages.length - effectiveMemorySize);
  }

  try {
    const client = axios.create({
      baseURL: process.env.LLM_ENDPOINT,
      headers: {
        'Authorization': `Bearer ${process.env.LLM_API}`,
        'Content-Type': 'application/json'
      }
    });
    
    const toolsEnabled = process.env.ENABLE_TOOLS !== "false";
    
    let requestBody = {
      model: process.env.LLM,
      messages: messages,
      stream: false
    };

    if (toolsEnabled) {
      requestBody.tools = AVAILABLE_TOOLS;
      requestBody.tool_choice = "auto";
    }

    // Tool calling loop (unchanged)
    let maxIterations = 5;
    let iteration = 0;
    let finalResponse = null;
    
    while (iteration < maxIterations) {
      iteration++;
      logToConsole(`> Sending LLM request (attempt ${iteration}/${maxIterations})`, 'info', 2);
      
      const response = await client.post('/chat/completions', requestBody);
      const choice = response.data.choices[0];
      const responseMessage = choice.message;
      
      if (toolsEnabled && responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        logToConsole(`✓ LLM wants to use ${responseMessage.tool_calls.length} tool(s)!`, 'info', 1);
        
        messages.push({
          role: 'assistant',
          content: responseMessage.content || null,
          tool_calls: responseMessage.tool_calls
        });
        
        for (const toolCall of responseMessage.tool_calls) {
          const toolName = toolCall.function.name;
          const toolArgs = toolCall.function.arguments;
          
          logToConsole(`> Calling tool: ${toolName}`, 'info', 1);
          const toolResult = await executeTool(toolName, toolArgs);
          
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolName,
            content: toolResult
          });
          
          logToConsole(`✓ Tool completed: ${toolResult.substring(0, 100)}${toolResult.length > 100 ? '...' : ''}`, 'info', 1);
        }
        
        requestBody.messages = messages;
      } else {
        finalResponse = responseMessage.content;
        logToConsole(`> LLM final response received (${finalResponse.length} chars)`, 'info', 2);
        break;
      }
    }
    
    if (iteration >= maxIterations) {
      logToConsole('! Maximum tool iterations reached', 'warn', 1);
      currentlythinking = false;
      return;
    }
    
    if (!finalResponse) {
      logToConsole('X No response content from LLM', 'error', 1);
      currentlythinking = false;
      return;
    }

    logToConsole(`> LLM Response: ${finalResponse}`, 'info', 1);

    if (finalResponse.includes("[IGNORING]")) {
      currentlythinking = false;
      logToConsole('> LLM Ignored the command.', 'info', 2);
      return;
    }

    // Parse memories and clean response
    const cleanedResponse = await parseMemoryTags(finalResponse, primaryUserId);
    const fullyCleaned = cleanLLMResponse(cleanedResponse);

    messages.push({
      role: 'assistant',
      content: fullyCleaned
    });
    
    chatHistory[primaryUserId] = messages;

    // Save to chat log
    await saveChatLog(primaryUserId, conversationText, fullyCleaned, channel);

    // Update transcription file if needed
    if (transcribemode) {
      if (!fs.existsSync('./transcription.txt')) {
        fs.writeFileSync('./transcription.txt', '');
      }
      fs.appendFileSync('./transcription.txt', `${conversationText}\n\nAssistant: ${fullyCleaned}\n\n`);
    }

    // Send to TTS
    sendToTTS(fullyCleaned, primaryUserId, connection, channel);
    
  } catch (error) {
    currentlythinking = false;
    logToConsole(`X Failed to communicate with LLM: ${error.message}`, 'error', 1);
    
    if (error.response) {
      logToConsole(`X HTTP Status: ${error.response.status}`, 'error', 1);
      logToConsole(`X Response data: ${JSON.stringify(error.response.data).substring(0, 500)}`, 'error', 1);
    }
  }
}

let audioqueue = [];

async function sendToTTS(text, userid, connection, channel) {
  const words = text.split(' ');
  const maxChunkSize = 60; // Maximum words per chunk
  const punctuationMarks = ['.', '!', '?', ';', ':']; // Punctuation marks to look for
  const chunks = [];

  for (let i = 0; i < words.length;) {
    let end = Math.min(i + maxChunkSize, words.length); // Find the initial end of the chunk

    // If the initial end is not the end of the text, try to find a closer punctuation mark
    if (end < words.length) {
      let lastPunctIndex = -1;
      for (let j = i; j < end; j++) {
        if (punctuationMarks.includes(words[j].slice(-1))) {
          lastPunctIndex = j;
        }
      }
      // If a punctuation mark was found, adjust the end to be after it
      if (lastPunctIndex !== -1) {
        end = lastPunctIndex + 1;
      }
    }

    // Create the chunk from i to the new end, then adjust i to start the next chunk
    chunks.push(words.slice(i, end).join(' '));
    i = end;
  }

  for (const chunk of chunks) {
    try {
      if(process.env.TTS_TYPE === "speecht5"){
        logToConsole('> Using Norman TTS', 'info', 2);
        const response = await axios.post(process.env.TTS_ENDPOINT + '/synthesize', {
          text: chunk,
        }, {
          responseType: 'arraybuffer'
        });

        const audioBuffer = Buffer.from(response.data);

        // save the audio buffer to a file
        const filename = `./sounds/tts_${chunks.indexOf(chunk)}.wav`;
        fs.writeFileSync(filename, audioBuffer);

        
          audioqueue.push({ file: filename, index: chunks.indexOf(chunk) });

          if (audioqueue.length === 1) {
            playAudioQueue(connection, channel, userid);
          }
        
      }
      else{
        logToConsole('> Using OpenAI TTS', 'info', 2);

        const response = await axios.post(process.env.OPENAI_TTS_ENDPOINT + '/v1/audio/speech', {
          model: process.env.TTS_MODEL,
          input: chunk,
          voice: process.env.TTS_VOICE,
          response_format: "mp3",
          speed: 1.0
        }, {
          responseType: 'arraybuffer'
        });

        const audioBuffer = Buffer.from(response.data);

        // save the audio buffer to a file
        const filename = `./sounds/tts_${chunks.indexOf(chunk)}.mp3`;
        fs.writeFileSync(filename, audioBuffer);

        
          audioqueue.push({ file: filename, index: chunks.indexOf(chunk) });

          if (audioqueue.length === 1) {
            logToConsole('> Playing audio queue', 'info', 2);
            playAudioQueue(connection, channel, userid);
          }
        
      }
    } catch (error) {
      currentlythinking = false;
      logToConsole(`X Failed to send text to TTS: ${error.message}`, 'error', 1);
    }
  }
}

let currentIndex = 0;
let retryCount = 0;
const maxRetries = 5; // Maximum number of retries before giving up

async function playAudioQueue(connection, channel, userid) {
  // Sort the audioqueue based on the index to ensure the correct play order
  audioqueue.sort((a, b) => a.index - b.index);

  while (audioqueue.length > 0) {
    const audio = audioqueue.find(a => a.index === currentIndex);
    if (audio) {
      // Create an audio player
      const player = createAudioPlayer();
      
      // Create an audio resource from a local file
      const resource = createAudioResource(audio.file);
      
      // Subscribe the connection to the player and play the resource
      connection.subscribe(player);
      player.play(resource);

      player.on('idle', async () => {
        // Delete the file after it's played
        try {
          fs.unlinkSync(audio.file);
        } catch (err) {
          logToConsole(`X Failed to delete file: ${err.message}`, 'error', 1);
        }

        // Remove the played audio from the queue
        audioqueue = audioqueue.filter(a => a.index !== currentIndex);
        currentIndex++;
        retryCount = 0; // Reset retry count for the next index

        if (audioqueue.length > 0) {
          await playAudioQueue(connection, channel, userid); // Continue playing
        } else {
          currentlythinking = false;
          audioqueue = [];
          currentIndex = 0;
          retryCount = 0;
          logToConsole('> Audio queue finished.', 'info', 2);
        }
      });

      player.on('error', error => logToConsole(`Error: ${error.message}`, 'error', 1));

      break; // Exit the while loop after setting up the player for the current index
    } else {
      // If the expected index is not found, wait 1 second and increase the retry count
      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        retryCount++;
      } else {
        currentlythinking = false;
        audioqueue = [];
        currentIndex = 0;
        retryCount = 0;
        logToConsole(`X Failed to find audio with index ${currentIndex} after ${maxRetries} retries.`, 'error', 1);
        break; // Give up after exceeding retry limit
      }
    }
  }
}

function restartListening(userID, connection, channel) {
  handleRecordingForUser(userID, connection, channel);
}

function logToConsole(message, level, type) {
  switch (level) {
    case 'info':
      if (process.env.LOG_TYPE >= type) {
        console.info(message);
      }
      break;
    case 'warn':
      if (process.env.LOG_TYPE >= type) {
        console.warn(message);
      }
      break;
    case 'error':
      console.error(message);
      break;
  }
}

function cleanLLMResponse(text) {
  // Remove <think>...</think> tags and their content
  let cleaned = text.replace(/<think>.*?<\/think>/gs, '');
  
  // Remove any other common reasoning tags if needed
  cleaned = cleaned.replace(/<reasoning>.*?<\/reasoning>/gs, '');
  cleaned = cleaned.replace(/<analysis>.*?<\/analysis>/gs, '');
  cleaned = cleaned.replace(/<memories>.*?<\/memories>/gs, '');

  // Remove markdown bold (**text**) and italic (*text*)
  // This preserves the text but removes the asterisks
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');  // Remove **bold**
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');      // Remove *italic*

  // Clean up extra whitespace and newlines
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  
  return cleaned;
}

client.login(TOKEN);
