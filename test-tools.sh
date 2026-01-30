#!/bin/bash
# Test script for Witness MCP tools
# Tests all 6 tools via direct HTTP calls

set -e
echo "🧪 Testing Witness MCP Tools"
echo "================================"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Test counter
PASSED=0
FAILED=0

test_tool() {
    local tool_name=$1
    local args=$2
    local session_id=$3

    echo "Testing: $tool_name"

    # Make the request
    response=$(curl -s -X POST http://localhost:3000/mcp \
        -H "Content-Type: application/json" \
        -H "mcp-session-id: $session_id" \
        -d "{
            \"jsonrpc\": \"2.0\",
            \"id\": $(date +%s),
            \"method\": \"tools/call\",
            \"params\": {
                \"name\": \"$tool_name\",
                \"arguments\": $args
            }
        }")

    # Check for error
    if echo "$response" | grep -q "error"; then
        echo -e "${RED}✗ FAILED${NC}"
        echo "Response: $response"
        FAILED=$((FAILED + 1))
        return 1
    else
        echo -e "${GREEN}✓ PASSED${NC}"
        PASSED=$((PASSED + 1))
        return 0
    fi
}

# Wait for server
echo "Checking if server is running..."
if ! curl -s http://localhost:3000/health > /dev/null; then
    echo "❌ Server not running on port 3000"
    exit 1
fi
echo -e "${GREEN}✓ Server is running${NC}"
echo ""

# Note: These tests require a valid session from Claude Desktop
# For now, just verify the server is running and tools are registered
echo "Note: Full tool testing requires active Claude Desktop session"
echo "Please test tools manually via Claude Desktop interface"
echo ""

# Test that we can list tools
echo "Testing tools/list endpoint..."
response=$(curl -s -X POST http://localhost:3000/mcp \
    -H "Content-Type: application/json" \
    -d '{
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1.0.0"}
        }
    }')

session_id=$(echo "$response" | grep -o 'session-[^"]*' | head -1)

if [ -n "$session_id" ]; then
    echo -e "${GREEN}✓ Session created: $session_id${NC}"

    # List tools
    tools_response=$(curl -s -X POST http://localhost:3000/mcp \
        -H "Content-Type: application/json" \
        -H "mcp-session-id: $session_id" \
        -d '{
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {}
        }')

    # Count tools
    tool_count=$(echo "$tools_response" | grep -o '"name":"[^"]*"' | wc -l)
    echo "Tools registered: $tool_count"

    if [ "$tool_count" -eq 6 ]; then
        echo -e "${GREEN}✓ All 6 tools registered${NC}"
    else
        echo -e "${RED}✗ Expected 6 tools, found $tool_count${NC}"
    fi

    echo ""
    echo "Registered tools:"
    echo "$tools_response" | grep -o '"name":"[^"]*"' | sed 's/"name":"/  - /' | sed 's/"$//'
else
    echo -e "${RED}✗ Failed to create session${NC}"
fi

echo ""
echo "================================"
echo "Manual Testing Instructions:"
echo "================================"
echo ""
echo "1. Test read_file:"
echo "   Ask Claude: 'Read the file README.md from my vault'"
echo ""
echo "2. Test write_file:"
echo "   Ask Claude: 'Create a file test.md in chaos/inbox with content: Hello World'"
echo ""
echo "3. Test list_files:"
echo "   Ask Claude: 'List all files in the chaos folder'"
echo ""
echo "4. Test edit_file:"
echo "   Ask Claude: 'In test.md, replace Hello with Goodbye'"
echo ""
echo "5. Test search:"
echo "   Ask Claude: 'Search for the word World in my vault'"
echo ""
echo "6. Test execute_command:"
echo "   Ask Claude: 'Execute the command app:reload to reload Obsidian'"
echo ""
