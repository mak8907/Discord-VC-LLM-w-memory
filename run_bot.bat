@echo off
        node bot.js
	python ToolServer.py
	python TTSserver.py
	python WhisperServer.py
        pause