from flask import Flask, request, Response, jsonify
import pyttsx3
import tempfile
import os
import subprocess
import sys
import multiprocessing
from multiprocessing import Process, Queue
import time

app = Flask(__name__)

def clean_text_for_tts(text):
    """Clean text to avoid TTS issues with certain characters"""
    # Replace problematic punctuation that might cause TTS to stop
    text = text.replace(':', ', ')  # Replace colon with comma and space
    text = text.replace(';', ', ')  # Replace semicolon with comma and space
    text = text.replace('—', ' - ')  # Replace em dash
    text = text.replace('–', ' - ')  # Replace en dash
    text = text.replace('"', ' ')   # Remove quotes that might cause issues
    text = text.replace('"', ' ')   # Remove fancy quotes
    text = text.replace('"', ' ')   # Remove fancy quotes
    text = text.replace(''', "'")   # Replace fancy apostrophe
    text = text.replace(''', "'")   # Replace fancy apostrophe
    
    # Clean up multiple spaces
    text = ' '.join(text.split())
    
    return text

def tts_worker(text, output_file, result_queue):
    """Worker process that handles TTS generation"""
    try:
        print(f"TTS Worker: Starting synthesis for: {text[:50]}...")
        
        # Initialize engine in this process
        engine = pyttsx3.init()
        
        # Configure engine
        voices = engine.getProperty('voices')
        if voices:
            voice_index = 0  # Change this to try different voices
            if len(voices) > voice_index:
                engine.setProperty('voice', voices[voice_index].id)
        
        engine.setProperty('rate', 150)
        engine.setProperty('volume', 0.9)
        
        # Generate speech
        engine.save_to_file(text, output_file)
        engine.runAndWait()
        
        # Check if file was created and has content
        if os.path.exists(output_file) and os.path.getsize(output_file) > 0:
            result_queue.put(('success', f'Generated audio file: {os.path.getsize(output_file)} bytes'))
        else:
            result_queue.put(('error', 'Audio file was not created or is empty'))
            
    except Exception as e:
        result_queue.put(('error', f'TTS worker error: {str(e)}'))
    finally:
        # Clean up engine
        try:
            engine.stop()
        except:
            pass

@app.route('/synthesize', methods=['POST'])
def synthesize():
    try:
        data = request.get_json()
        text = data.get('text')
        
        if not text:
            return jsonify({'error': 'No text provided'}), 400
        
        # Clean the text to avoid TTS issues
        cleaned_text = clean_text_for_tts(text)
        print(f"Original: {text}")
        print(f"Cleaned: {cleaned_text}")
        
        # Create a temporary file for the audio
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp_file:
            temp_filename = tmp_file.name
        
        # Create a queue for communication with the worker process
        result_queue = Queue()
        
        # Start the TTS worker process
        worker = Process(target=tts_worker, args=(cleaned_text, temp_filename, result_queue))
        worker.start()
        
        # Wait for the worker to complete (with timeout)
        worker.join(timeout=30)  # 30 second timeout
        
        if worker.is_alive():
            # Process is still running, terminate it
            worker.terminate()
            worker.join()
            if os.path.exists(temp_filename):
                os.unlink(temp_filename)
            return jsonify({'error': 'TTS process timed out'}), 500
        
        # Check if worker completed successfully
        if not result_queue.empty():
            status, message = result_queue.get()
            print(f"Worker result: {status} - {message}")
            
            if status == 'error':
                if os.path.exists(temp_filename):
                    os.unlink(temp_filename)
                return jsonify({'error': message}), 500
        
        # Wait a moment for file system to sync
        time.sleep(0.2)
        
        # Read the generated audio file
        try:
            if not os.path.exists(temp_filename):
                return jsonify({'error': 'Audio file was not created'}), 500
                
            with open(temp_filename, 'rb') as audio_file:
                audio_data = audio_file.read()
            
            if len(audio_data) == 0:
                return jsonify({'error': 'Generated audio file is empty'}), 500
            
            # Clean up temp file
            os.unlink(temp_filename)
            
            print(f"Successfully generated {len(audio_data)} bytes of audio")
            return Response(audio_data, mimetype='audio/wav')
            
        except Exception as file_error:
            print(f"Error reading audio file: {file_error}")
            # Clean up temp file even on error
            if os.path.exists(temp_filename):
                os.unlink(temp_filename)
            return jsonify({'error': f'Failed to read generated audio: {str(file_error)}'}), 500
        
    except Exception as e:
        print(f"Error in TTS: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/test_voices', methods=['GET'])
def test_voices():
    """Test endpoint to list available voices using a subprocess"""
    try:
        result_queue = Queue()
        
        def get_voices(queue):
            try:
                engine = pyttsx3.init()
                voices = engine.getProperty('voices')
                voice_list = []
                for i, voice in enumerate(voices):
                    voice_list.append({
                        'index': i,
                        'name': voice.name,
                        'id': voice.id
                    })
                queue.put(('success', voice_list))
                engine.stop()
            except Exception as e:
                queue.put(('error', str(e)))
        
        worker = Process(target=get_voices, args=(result_queue,))
        worker.start()
        worker.join(timeout=10)
        
        if worker.is_alive():
            worker.terminate()
            worker.join()
            return jsonify({'error': 'Voice detection timed out'}), 500
        
        if not result_queue.empty():
            status, data = result_queue.get()
            if status == 'success':
                return jsonify({'voices': data})
            else:
                return jsonify({'error': data}), 500
        
        return jsonify({'error': 'No response from voice detection'}), 500
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'method': 'process-based',
        'note': 'Each TTS request runs in a separate process'
    })

if __name__ == '__main__':
    # Set multiprocessing start method for compatibility
    if sys.platform.startswith('win'):
        multiprocessing.set_start_method('spawn', force=True)
    elif sys.platform.startswith('darwin'):  # macOS
        multiprocessing.set_start_method('spawn', force=True)
    
    print("Starting process-based pyttsx3 TTS server on port 5000...")
    print("Each TTS request will run in a fresh process to avoid engine lockups")
    print("Available endpoints:")
    print("  POST /synthesize - Generate speech")
    print("  GET  /test_voices - List available voices")
    print("  GET  /health - Health check")
    
    app.run(host='0.0.0.0', port=5000, debug=True)  # Debug=False for multiprocessing
