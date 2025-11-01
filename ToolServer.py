from flask import Flask, request, jsonify
import sys
import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import asyncio
import re
import math
import random

# Import the web search tool
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from llm_web_search import Tools as WebSearchTools

app = Flask(__name__)

# Initialize the web search tool
web_search_tools = WebSearchTools()

# ============= AUTO-CONFIGURE WEB SEARCH TOOL =============
# Set up the models directory automatically
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models')

# Create the models directory if it doesn't exist
if not os.path.exists(MODELS_DIR):
    os.makedirs(MODELS_DIR)
    print(f"[Tools API] Created models directory: {MODELS_DIR}")

# Configure the web search tool
web_search_tools.valves.embedding_model_save_path = MODELS_DIR
web_search_tools.valves.num_results = 10
web_search_tools.valves.max_results = 8
web_search_tools.valves.cpu_only = False  # Set to True if you don't have a GPU
web_search_tools.valves.simple_search = False
web_search_tools.valves.keep_results_in_context = False
web_search_tools.valves.duckduckgo_only = True
web_search_tools.valves.chunk_size = 400
web_search_tools.valves.include_citations = False
web_search_tools.valves.ensemble_weighting = 0.5
web_search_tools.valves.keyword_retriever = "bm25"  # Use bm25 (lighter) instead of splade
web_search_tools.valves.splade_batch_size = 8
web_search_tools.valves.chunker = "character-based"  # Must be either 'character-based', 'semantic' or 'neural'.
web_search_tools.valves.chunker_breakpoint_threshold_amount = 30
web_search_tools.valves.similarity_score_threshold = 0.5
web_search_tools.valves.client_timeout = 20
web_search_tools.valves.searxng_url = "None"

print(f"[Tools API] Web search configured:")
print(f"  - Models directory: {MODELS_DIR}")
print(f"  - CPU only mode: {web_search_tools.valves.cpu_only}")
print(f"  - Keyword retriever: {web_search_tools.valves.keyword_retriever}")
print(f"  - Chunker: {web_search_tools.valves.chunker}")
# ============= END AUTO-CONFIGURATION =============

# ============= CALCULATOR AND UNIT CONVERSION =============
# Common unit conversions (from -> to)
UNIT_CONVERSIONS = {
    # Temperature
    'fahrenheit_to_celsius': lambda f: (f - 32) * 5/9,
    'celsius_to_fahrenheit': lambda c: (c * 9/5) + 32,
    'f_to_c': lambda f: (f - 32) * 5/9,
    'c_to_f': lambda c: (c * 9/5) + 32,
    
    # Length
    'miles_to_kilometers': lambda m: m * 1.60934,
    'kilometers_to_miles': lambda k: k / 1.60934,
    'feet_to_meters': lambda f: f * 0.3048,
    'meters_to_feet': lambda m: m / 0.3048,
    'inches_to_centimeters': lambda i: i * 2.54,
    'centimeters_to_inches': lambda c: c / 2.54,
    'miles_to_km': lambda m: m * 1.60934,
    'km_to_miles': lambda k: k / 1.60934,
    'ft_to_m': lambda f: f * 0.3048,
    'm_to_ft': lambda m: m / 0.3048,
    
    # Weight/Mass
    'pounds_to_kilograms': lambda p: p * 0.453592,
    'kilograms_to_pounds': lambda k: k / 0.453592,
    'ounces_to_grams': lambda o: o * 28.3495,
    'grams_to_ounces': lambda g: g / 28.3495,
    'lbs_to_kg': lambda p: p * 0.453592,
    'kg_to_lbs': lambda k: k / 0.453592,
    
    # Volume
    'gallons_to_liters': lambda g: g * 3.78541,
    'liters_to_gallons': lambda l: l / 3.78541,
    'cups_to_milliliters': lambda c: c * 236.588,
    'milliliters_to_cups': lambda m: m / 236.588,
    'gal_to_l': lambda g: g * 3.78541,
    'l_to_gal': lambda l: l / 3.78541,
}

def safe_calculate(expression):
    """Safely evaluate a mathematical expression"""
    # Remove any potentially dangerous characters
    expression = expression.strip()
    
    # Allow only numbers, operators, parentheses, and math functions
    allowed_chars = set('0123456789+-*/().%^ ')
    allowed_words = {'sin', 'cos', 'tan', 'sqrt', 'log', 'ln', 'abs', 'pi', 'e'}
    
    # Replace common math terms
    expression = expression.replace('^', '**')  # Power operator
    expression = expression.replace('π', 'pi')
    expression = expression.replace('√', 'sqrt')
    
    # Create safe math namespace
    safe_dict = {
        'sin': math.sin,
        'cos': math.cos,
        'tan': math.tan,
        'sqrt': math.sqrt,
        'log': math.log10,
        'ln': math.log,
        'abs': abs,
        'pi': math.pi,
        'e': math.e,
        '__builtins__': {}
    }
    
    try:
        result = eval(expression, safe_dict)
        return result
    except Exception as e:
        raise ValueError(f"Invalid mathematical expression: {str(e)}")

def convert_units(value, conversion_type):
    """Convert between units"""
    conversion_key = conversion_type.lower().replace(' ', '_')
    
    if conversion_key in UNIT_CONVERSIONS:
        result = UNIT_CONVERSIONS[conversion_key](value)
        return result
    else:
        raise ValueError(f"Unknown conversion type: {conversion_type}")

# ============= END CALCULATOR =============

# ============= RPG DICE ROLLER =============
def rpg_dice_roll(dice_expression: str) -> str:
    """
    Rolls a given number of dice with a given number of sides.
    The expression should be in the format 'XdY' (e.g., '2d6', '1d20', '3d10').
    X is the number of dice, Y is the number of sides per die.
    """
    # Regex to parse the dice expression
    match = re.match(r"(\d+)[dD](\d+)", dice_expression.strip())
    if not match:
        return "Invalid dice expression. Please use the format 'XdY' (e.g., '2d6', '1d20')."

    num_dice = int(match.group(1))
    num_sides = int(match.group(2))

    if num_dice <= 0 or num_sides <= 0:
        return "The number of dice and sides must be greater than zero."
    
    if num_dice > 100:
        return "Maximum 100 dice allowed per roll."

    results = [random.randint(1, num_sides) for _ in range(num_dice)]
    total = sum(results)
    
    return f"Rolling {dice_expression}: {results}. Total: {total}"
# ============= END DICE ROLLER =============

# Mock user and event emitter for the tools
mock_user = {"id": "discord_bot"}

async def mock_event_emitter(event):
    """Mock event emitter that just logs events"""
    event_type = event.get('type', 'unknown')
    if event_type == 'status':
        status_data = event.get('data', {})
        print(f"[Event] Status: {status_data.get('description', 'No description')}")
    elif event_type == 'citation':
        print(f"[Event] Citation added")
    else:
        print(f"[Event] {event_type}")

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'available_tools': ['search_web', 'search_webpage', 'getDateTime', 'calculate', 'convert_units', 'roll_dice'],
        'models_directory': MODELS_DIR,
        'config': {
            'cpu_only': web_search_tools.valves.cpu_only,
            'keyword_retriever': web_search_tools.valves.keyword_retriever,
            'chunker': web_search_tools.valves.chunker
        }
    })

@app.route('/tools/search_web', methods=['POST'])
def search_web():
    """
    Search the web for information
    Expected JSON: { "query": "search query" }
    """
    try:
        data = request.get_json()
        
        if not data or 'query' not in data:
            return jsonify({'error': 'Missing required parameter: query'}), 400
        
        query = data['query']
        print(f"\n[Tools API] Web search request: {query}")
        
        # Run the async search_web function
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result = loop.run_until_complete(
                web_search_tools.search_web(query, mock_user, mock_event_emitter)
            )
        finally:
            loop.close()
        
        print(f"[Tools API] Search completed, result length: {len(result)} chars")
        
        return jsonify({
            'success': True,
            'result': result
        })
        
    except Exception as e:
        print(f"[Tools API] Error in search_web: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/tools/search_webpage', methods=['POST'])
def search_webpage():
    """
    Search a specific webpage
    Expected JSON: { "query": "search query", "webpage": "url or domain" }
    """
    try:
        data = request.get_json()
        
        if not data or 'query' not in data or 'webpage' not in data:
            return jsonify({'error': 'Missing required parameters: query, webpage'}), 400
        
        query = data['query']
        webpage = data['webpage']
        print(f"\n[Tools API] Webpage search request: {query} on {webpage}")
        
        # Run the async search_webpage function
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result = loop.run_until_complete(
                web_search_tools.search_webpage(query, webpage, mock_user, mock_event_emitter)
            )
        finally:
            loop.close()
        
        print(f"[Tools API] Webpage search completed")
        
        return jsonify({
            'success': True,
            'result': result
        })
        
    except Exception as e:
        print(f"[Tools API] Error in search_webpage: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/tools/getDateTime', methods=['POST', 'GET'])
def get_date_time():
    """
    Get current date and time
    No parameters required
    """
    try:
        print("\n[Tools API] DateTime request")
        
        # Using the same logic from getDateTime.py
        desired_timezone = "America/Phoenix"  # You can make this configurable
        
        now_utc = datetime.now(timezone.utc)
        tz = ZoneInfo(desired_timezone)
        now_desired = now_utc.astimezone(tz)
        
        current_date = now_desired.strftime("%A, %B %d, %Y")
        current_time = now_desired.strftime("%I:%M %p")
        
        result = f"Today's date is {current_date}. The current time is {current_time}."
        
        print(f"[Tools API] DateTime result: {result}")
        
        return jsonify({
            'success': True,
            'result': result,
            'date': current_date,
            'time': current_time,
            'timezone': desired_timezone
        })
        
    except Exception as e:
        print(f"[Tools API] Error in getDateTime: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/tools/calculate', methods=['POST'])
def calculate():
    """
    Perform mathematical calculations
    Expected JSON: { "expression": "2 + 2" }
    """
    try:
        data = request.get_json()
        
        if not data or 'expression' not in data:
            return jsonify({'error': 'Missing required parameter: expression'}), 400
        
        expression = data['expression']
        print(f"\n[Tools API] Calculate request: {expression}")
        
        result = safe_calculate(expression)
        result_text = f"The result of {expression} is {result}"
        
        print(f"[Tools API] Calculation result: {result}")
        
        return jsonify({
            'success': True,
            'result': result_text,
            'value': result
        })
        
    except Exception as e:
        print(f"[Tools API] Error in calculate: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/tools/convert_units', methods=['POST'])
def convert_units_endpoint():
    """
    Convert between units
    Expected JSON: { "value": 100, "conversion": "fahrenheit_to_celsius" }
    """
    try:
        data = request.get_json()
        
        if not data or 'value' not in data or 'conversion' not in data:
            return jsonify({'error': 'Missing required parameters: value, conversion'}), 400
        
        value = float(data['value'])
        conversion = data['conversion']
        
        print(f"\n[Tools API] Unit conversion request: {value} {conversion}")
        
        result = convert_units(value, conversion)
        
        # Parse conversion type for nice output
        parts = conversion.replace('_to_', ' to ').replace('_', ' ')
        result_text = f"{value} {parts.split(' to ')[0]} equals {result:.2f} {parts.split(' to ')[1]}"
        
        print(f"[Tools API] Conversion result: {result}")
        
        return jsonify({
            'success': True,
            'result': result_text,
            'value': result
        })
        
    except Exception as e:
        print(f"[Tools API] Error in convert_units: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/tools/roll_dice', methods=['POST'])
def roll_dice():
    """
    Roll RPG dice
    Expected JSON: { "dice_expression": "2d6" }
    """
    try:
        data = request.get_json()
        
        if not data or 'dice_expression' not in data:
            return jsonify({'error': 'Missing required parameter: dice_expression'}), 400
        
        dice_expression = data['dice_expression']
        print(f"\n[Tools API] Dice roll request: {dice_expression}")
        
        result = rpg_dice_roll(dice_expression)
        
        print(f"[Tools API] Dice roll result: {result}")
        
        return jsonify({
            'success': True,
            'result': result
        })
        
    except Exception as e:
        print(f"[Tools API] Error in roll_dice: {str(e)}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

@app.route('/tools/execute', methods=['POST'])
def execute_tool():
    """
    Generic endpoint to execute any tool
    Expected JSON: { "tool": "tool_name", "parameters": {...} }
    """
    try:
        data = request.get_json()
        
        if not data or 'tool' not in data:
            return jsonify({'error': 'Missing required parameter: tool'}), 400
        
        tool_name = data['tool']
        parameters = data.get('parameters', {})
        
        print(f"\n[Tools API] Execute tool request: {tool_name}")
        
        if tool_name == 'search_web':
            if 'query' not in parameters:
                return jsonify({'error': 'Missing query parameter'}), 400
            
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                result = loop.run_until_complete(
                    web_search_tools.search_web(parameters['query'], mock_user, mock_event_emitter)
                )
            finally:
                loop.close()
            
        elif tool_name == 'search_webpage':
            if 'query' not in parameters or 'webpage' not in parameters:
                return jsonify({'error': 'Missing query or webpage parameter'}), 400
            
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                result = loop.run_until_complete(
                    web_search_tools.search_webpage(
                        parameters['query'], 
                        parameters['webpage'], 
                        mock_user, 
                        mock_event_emitter
                    )
                )
            finally:
                loop.close()
            
        elif tool_name == 'getDateTime':
            desired_timezone = parameters.get('timezone', 'America/Phoenix')
            now_utc = datetime.now(timezone.utc)
            tz = ZoneInfo(desired_timezone)
            now_desired = now_utc.astimezone(tz)
            current_date = now_desired.strftime("%A, %B %d, %Y")
            current_time = now_desired.strftime("%I:%M %p")
            result = f"Today's date is {current_date}. The current time is {current_time}."
            
        elif tool_name == 'calculate':
            if 'expression' not in parameters:
                return jsonify({'error': 'Missing expression parameter'}), 400
            calc_result = safe_calculate(parameters['expression'])
            result = f"The result of {parameters['expression']} is {calc_result}"
            
        elif tool_name == 'convert_units':
            if 'value' not in parameters or 'conversion' not in parameters:
                return jsonify({'error': 'Missing value or conversion parameter'}), 400
            conv_result = convert_units(float(parameters['value']), parameters['conversion'])
            parts = parameters['conversion'].replace('_to_', ' to ').replace('_', ' ')
            result = f"{parameters['value']} {parts.split(' to ')[0]} equals {conv_result:.2f} {parts.split(' to ')[1]}"
            
        elif tool_name == 'roll_dice':
            if 'dice_expression' not in parameters:
                return jsonify({'error': 'Missing dice_expression parameter'}), 400
            result = rpg_dice_roll(parameters['dice_expression'])
            
        else:
            return jsonify({'error': f'Unknown tool: {tool_name}'}), 400
        
        return jsonify({
            'success': True,
            'tool': tool_name,
            'result': result
        })
        
    except Exception as e:
        print(f"[Tools API] Error executing tool: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500

if __name__ == '__main__':
    print("=" * 60)
    print("Starting Tools API Server on port 5001...")
    print("=" * 60)
    print("\nAvailable endpoints:")
    print("  POST /tools/search_web      - Search the web")
    print("  POST /tools/search_webpage  - Search a specific webpage")
    print("  POST /tools/getDateTime     - Get current date/time")
    print("  POST /tools/calculate       - Perform math calculations")
    print("  POST /tools/convert_units   - Convert between units")
    print("  POST /tools/roll_dice       - Roll RPG dice")
    print("  POST /tools/execute         - Generic tool execution")
    print("  GET  /health                - Health check")
    print("\nConfiguration:")
    print(f"  Models directory: {MODELS_DIR}")
    print(f"  CPU only: {web_search_tools.valves.cpu_only}")
    print(f"  Keyword retriever: {web_search_tools.valves.keyword_retriever}")
    
    if not web_search_tools.valves.cpu_only:
        try:
            import torch
            if torch.cuda.is_available():
                print(f"  GPU available: {torch.cuda.get_device_name(0)}")
            else:
                print("  GPU: Not available (will use CPU)")
        except:
            print("  GPU: PyTorch not installed or no GPU")
    
    print("=" * 60)
    print("\nFirst run will download embedding models (~100MB)")
    print("This may take a few minutes...\n")
    
    app.run(host='0.0.0.0', port=5001, debug=True)