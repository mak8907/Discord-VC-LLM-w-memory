from flask import Flask, request, jsonify
import whisper
import tempfile
import os

app = Flask(__name__)
model = whisper.load_model("base")

@app.route('/v1/audio/transcriptions', methods=['POST'])
def transcribe():
    tmp_file_path = None
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400
            
        audio_file = request.files['file']
        
        if audio_file.filename == '':
            return jsonify({'error': 'No file selected'}), 400
        
        # Save the uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix='.mp3') as tmp_file:
            tmp_file_path = tmp_file.name
            audio_file.save(tmp_file_path)
        
        # Transcribe the audio (file is now closed)
        result = model.transcribe(tmp_file_path)
        
        # Return in the format expected by the bot
        return jsonify({
            'text': result['text']
        })
        
    except Exception as e:
        print(f"Transcription error: {str(e)}")
        return jsonify({'error': str(e)}), 500
        
    finally:
        # Clean up the temporary file in the finally block
        if tmp_file_path and os.path.exists(tmp_file_path):
            try:
                os.unlink(tmp_file_path)
            except Exception as cleanup_error:
                print(f"Warning: Could not delete temp file {tmp_file_path}: {cleanup_error}")

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'healthy'})

if __name__ == '__main__':
    print("Starting Whisper transcription server on port 8001...")
    app.run(host='0.0.0.0', port=8001, debug=True)
