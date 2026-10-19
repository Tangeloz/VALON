@echo off
echo =======================================================
echo 🛸 FLOW-UFO DRONE VIDEO STREAM
echo =======================================================
echo Make sure you are connected to FLOW-UFO-XXXXX WiFi!
echo.
echo Launching VLC Media Player...
echo URL: rtsp://192.168.1.1:7070/webcam
echo.

"C:\Program Files\VideoLAN\VLC\vlc.exe" rtsp://192.168.1.1:7070/webcam --network-caching=300

if %errorlevel% neq 0 (
    echo.
    echo ❌ VLC not found at default location or an error occurred.
    echo If VLC is installed elsewhere, please open it manually and go to:
    echo Media -^> Open Network Stream
    echo And paste this exact URL: rtsp://192.168.1.1:7070/webcam
)

pause
