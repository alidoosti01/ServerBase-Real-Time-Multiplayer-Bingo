#!/bin/bash

echo "🎮 Starting Multiplayer Bingo Server..."
echo ""

if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Start the application
echo "🐳 Starting Docker containers..."
docker-compose up -d

echo ""
echo "✅ Server is starting!"
echo "🌐 Access the application at: http://localhost:3000"
echo ""
echo "📝 Default admin credentials:"
echo "   Username: admin"
echo "   Password: admin123"
echo ""
echo "💡 To view logs: docker-compose logs -f"
echo "💡 To stop: docker-compose down"
echo ""
