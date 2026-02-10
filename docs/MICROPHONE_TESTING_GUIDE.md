# Microphone Testing Interface - SVphone v06.04

**Commit**: 9f086b1

## Overview

The microphone testing interface allows users to verify their microphone is working correctly before attempting calls. It provides real-time audio level monitoring, volume control, mute toggle, and recording/playback functionality.

## User Guide

### Starting a Test

1. Open the phone interface (phone_interface.html)
2. Look for the **"🎤 Microphone Test"** section in the left panel (Call Controls)
3. Click **"🎤 Start Test"** button
4. **Browser permission dialog will appear** asking for microphone access
5. Click **"Allow"** to grant access

### What You'll See

**Audio Level Meter:**
- Canvas visualization showing real-time audio input levels
- **Color feedback**: Green (quiet) → Orange (medium) → Red (loud)
- **dB indicator**: Shows decibel level from -60dB to 0dB
- Updates 60 times per second for smooth animation

### Controls

#### Volume Slider
- **Range**: 0% to 200%
- **Default**: 100% (normal level)
- **Effect**: Adjusts input gain in real-time
- **Use case**: Test audio levels at different gains

#### Mute Checkbox
- **Function**: Silences microphone input
- **Effect**: Meter shows no activity when muted
- **Use case**: Quickly test mute toggle functionality

#### Recording Button
- **Duration**: Up to 10 seconds maximum
- **Auto-stop**: Automatically stops at 10 seconds
- **Status**: Timer shows elapsed time (0:00 / 0:10)
- **Format**: WebM audio with Opus codec

#### Playback Button
- **Enabled**: Only after recording is complete
- **Function**: Plays back recorded audio
- **Use case**: Verify audio quality and clarity

### Troubleshooting

#### "Permission denied by system"
**Windows 11 Privacy Settings:**
1. Open **Settings** (Win+I)
2. Go to **Privacy & Security** → **Microphone**
3. Toggle **Microphone access** to **ON**
4. Enable your browser in the app list
5. Restart browser and try again

#### "No microphone detected"
1. Check if microphone is plugged in
2. Check if microphone is enabled (not muted by hardware switch)
3. Restart the browser
4. Check Windows privacy settings (above)

#### "Microphone in use by another application"
1. Close other apps using microphone (Zoom, Discord, etc.)
2. Click **Stop Test** then **Start Test** again

#### No Audio Output or Very Quiet
1. Adjust the **Input Gain** slider
2. Check microphone distance and position
3. Try speaking louder and closer to microphone
4. Check Windows volume levels for microphone

### Workflow

**Typical testing sequence:**
1. Click **Start Test**
2. Grant microphone permission
3. Speak normally and watch meter activity
4. Adjust volume slider if needed
5. Test mute functionality
6. Record a 5-second message
7. Play it back to verify quality
8. Click **Stop Test** when done
9. Proceed to make call

## Technical Implementation

### Architecture

**MicrophoneTester Class** (`src/sv_connect/microphone_tester.js`)

```javascript
// Main components
class MicrophoneTester {
    async startTest()           // Initialize audio context and stream
    stopTest()                  // Cleanup and release resources
    setVolume(value)            // Adjust gain node (0-200%)
    setMute(isMuted)            // Mute/unmute by setting gain to 0
    async startRecording()      // Start MediaRecorder (10s max)
    stopRecording()             // Stop recording and create blob
    playRecording()             // Play recorded audio
    drawMeter()                 // Canvas rendering (60fps)
}
```

### Web Audio API Graph

```
getUserMedia (microphone stream)
    ↓
MediaStreamSource Node
    ↓
GainNode (volume control: 0.0-2.0)
    ↓
AnalyserNode (FFT size: 2048)
    ├─→ getByteTimeDomainData() → Canvas
    └─→ AudioContext.destination (speaker output)

Parallel Recording Path:
MediaStream → MediaRecorder → Blob → Audio playback
```

### Audio Processing

**RMS Calculation (for VU meter):**
1. Get 2048 samples from analyser (time-domain data)
2. Normalize each sample (divide by 128, subtract 0.5)
3. Calculate root mean square (RMS) of all samples
4. Convert RMS to decibels: `20 * log10(RMS)`
5. Map dB value to canvas bar width (−60dB to 0dB = 0% to 100%)

**Color Gradient:**
- Green: -60dB to -20dB (quiet)
- Orange: -20dB to -10dB (medium)
- Red: -10dB to 0dB (loud)

### Recording

- **Codec**: WebM with Opus audio codec
- **Fallback**: Tries multiple MIME types for browser compatibility
- **Duration**: Maximum 10 seconds (enforced by timer)
- **Chunks**: Collected in array, combined into Blob on stop

### Event Handling

**Status Messages:**
- User-friendly error messages with diagnostic info
- Color-coded (error=red, success=green, info=blue, warning=orange)
- Multi-line support for detailed instructions

**Permission Errors:**
- `NotAllowedError`: User denied permission
- `NotFoundError`: No microphone detected
- `NotReadableError`: Microphone in use by another app
- `SecurityError`: HTTPS required or secure context needed

## UI Components

### Layout
```
Call Controls Panel
├─ Form Inputs (address, IP, port, quality)
├─ Microphone Test Section (COLLAPSIBLE)
│   ├─ Start/Stop buttons
│   ├─ VU meter canvas
│   ├─ Volume slider
│   ├─ Mute checkbox
│   ├─ Recording controls
│   └─ Status display
├─ Initiate Call button
└─ Status panel
```

### Styling
- Background: `rgba(255, 255, 255, 0.05)` with border
- Canvas: 400×40px with gradient visualization
- Slider: Custom styled with color gradient
- Status: Color-coded with matching borders
- Animations: Smooth transitions (0.3s)

## Browser Compatibility

### Supported Browsers
- ✅ Chrome/Chromium (Edge, Arc, etc.)
- ✅ Firefox
- ✅ Safari 14.1+
- ✅ Mobile browsers (if microphone available)

### API Requirements
- **Web Audio API** (AudioContext, GainNode, AnalyserNode)
- **MediaDevices API** (getUserMedia)
- **MediaRecorder API** (recording functionality)
- **Canvas 2D** (VU meter visualization)

### Unsupported
- ❌ Internet Explorer (no Web Audio API)
- ❌ Very old browser versions (<2015)

## Performance Considerations

### CPU Usage
- VU meter: ~2-3% CPU (60fps canvas rendering)
- Total with idle app: ~5-8% CPU
- Recording: Minimal impact on CPU

### Memory
- Audio context: ~5-10 MB
- Recording buffer: ~100 KB per second (10 seconds = 1 MB max)
- Canvas memory: Negligible

### Optimizations
- RequestAnimationFrame for meter (respects 60fps)
- Stop animation when test inactive
- Cleanup all resources on stop
- Single canvas context (no recreation)
- Efficient RMS calculation (single pass)

## Known Limitations

1. **Volume Control**: Adjusts output gain, not input volume
   - Browser doesn't expose input volume control
   - Workaround: Adjust in OS or microphone settings

2. **Frequency Analysis**: Only time-domain analysis
   - No spectral frequency display
   - Could be added in future enhancement

3. **Recording Quality**: Depends on browser settings
   - Audio constraints: echo cancellation, noise suppression enabled
   - Can't control individual constraint values per WebRTC spec

4. **Playback Volume**: Uses browser default
   - Controlled by system volume, not app volume
   - User can adjust in OS while playing

## Future Enhancements

1. **Multiple Microphone Selection**
   - Dropdown to choose from `enumerateDevices()`
   - Remember user preference

2. **Frequency Spectrum Display**
   - Use `getByteFrequencyData()` for FFT analysis
   - Visual spectrum analyzer

3. **Echo Test**
   - Play test tone and record response
   - Detect echo cancellation quality

4. **Noise Analysis**
   - Detect background noise levels
   - Recommend noise suppression settings

5. **Export Recording**
   - Download WAV or MP3 file
   - Send to server for analysis

6. **Video Test** (Phase 2)
   - Similar interface for camera testing
   - Resolution selection
   - Camera preview with brightness/contrast controls

## Security

- **Permissions**: Only requests microphone (not camera)
- **Data**: All processing stays client-side
- **Recording**: Temporary storage only, cleared on stop
- **Privacy**: No data sent to server unless user exports

## Debugging

### Browser Console Logs

Check browser DevTools (F12 → Console) for debug messages:

```
[MicrophoneTester] Initialized
[MicrophoneTester] Starting test...
[MicrophoneTester] Got media stream: { audioTracks: 1 }
[MicrophoneTester] Audio graph connected
[MicrophoneTester] Canvas initialized: { width: 400, height: 40 }
[MicrophoneTester] Volume set to: 100%
[MicrophoneTester] Starting recording...
[MicrophoneTester] Recorded chunk: 8192 bytes
[MicrophoneTester] Recording stopped: 65536 bytes
[MicrophoneTester] Playing recording...
[MicrophoneTester] Test stopped and resources cleaned up
```

### Common Issues

**Issue**: Canvas not showing animation
- Check browser console for errors
- Verify microphone permission granted
- Try stopping and starting test again

**Issue**: Recording button disabled
- Ensure test is active first (click Start Test)
- Check microphone permission
- Try refreshing page

**Issue**: Playback plays but no sound
- Check system volume
- Check if browser audio is muted
- Check if microphone was actually recording (meter showed activity)

## API Reference

### Public Methods

```javascript
// Initialize test
await micTester.startTest()

// Stop test
micTester.stopTest()

// Control volume (0-200)
micTester.setVolume(100)

// Mute/unmute
micTester.setMute(true)  // mute
micTester.setMute(false) // unmute

// Recording (max 10 seconds)
await micTester.startRecording()
micTester.stopRecording()
micTester.playRecording()
```

### Properties

```javascript
micTester.isTestActive      // boolean: test running?
micTester.isMuted           // boolean: microphone muted?
micTester.isRecording       // boolean: recording in progress?
micTester.currentGain       // number: current gain (0.0-2.0)
micTester.recordedBlob      // Blob: recorded audio data
micTester.mediaStream       // MediaStream: active stream
micTester.audioContext      // AudioContext: Web Audio API context
```

## Conclusion

The microphone testing interface provides a complete diagnostic tool for users to verify their microphone setup before making calls. It handles permissions gracefully, provides real-time visual feedback, and helps users troubleshoot common issues.

For questions or issues, check browser console logs and the troubleshooting section above.
