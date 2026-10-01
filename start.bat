@echo off
cd /d "%~dp0"

echo Starting backend (FastAPI) on port 8000...
start "Road Inventory - Backend" cmd /k "backend\start-backend.bat"

echo Starting frontend (Vite) on port 5173...
start "Road Inventory - Frontend" cmd /k "frontend\start-frontend.bat"

echo.
echo Both servers are starting in separate windows.
echo Opening the app in your browser in a few seconds...
timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:5173"

echo.
echo To stop: close the two server windows (or press Ctrl+C in each).
pause
