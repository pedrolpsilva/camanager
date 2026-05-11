import React, { useEffect, useRef, useState } from 'react';
import { GoogleGenAI, Type } from '@google/genai';
import { Camera, Users, Clock, Code, Activity, AlertCircle, RefreshCw, Square, Play } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Person {
  id: number;
  gender: string;
  approximate_age: number;
  movement_type: string;
  is_hand_raised: boolean;
  bounding_box: BoundingBox;
}

interface AnalysisResult {
  people_count: number;
  people: Person[];
}

// --- Initialization ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const modelName = 'gemini-2.0-flash';

function CountdownTimer({ isAnalysisEnabled, isAnalyzingRef }: { isAnalysisEnabled: boolean, isAnalyzingRef: React.MutableRefObject<boolean> }) {
  const [secondsToNext, setSecondsToNext] = useState(10);

  useEffect(() => {
    if (!isAnalysisEnabled) {
      setSecondsToNext(10);
      return;
    }

    setSecondsToNext(10);
    const countdownInterval = setInterval(() => {
      if (!isAnalyzingRef.current) {
        setSecondsToNext(prev => (prev > 1 ? prev - 1 : 10));
      }
    }, 1000);

    return () => clearInterval(countdownInterval);
  }, [isAnalysisEnabled, isAnalyzingRef]);

  if (!isAnalysisEnabled) return null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 px-4 py-2 rounded-lg flex items-center gap-3">
      <RefreshCw className="w-4 h-4 text-orange-500" />
      <span className="text-xl font-mono font-bold text-orange-500 w-12 text-center">
        {secondsToNext}s
      </span>
      <span className="text-[10px] font-mono uppercase text-zinc-500 leading-none">
        Next<br/>Scan
      </span>
    </div>
  );
}

export default function App() {

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const isAnalyzingRef = useRef(false);
  const [isAnalysisEnabled, setIsAnalysisEnabled] = useState(true);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [lastJson, setLastJson] = useState<string>('');
  const [dwellTime, setDwellTime] = useState(0);
  const [emptyChecks, setEmptyChecks] = useState(0);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  const dwellStartRef = useRef<number | null>(null);

  // --- Sync isAnalyzingRef ---
  useEffect(() => {
    isAnalyzingRef.current = isAnalyzing;
  }, [isAnalyzing]);

  // --- Drawing Logic ---
  useEffect(() => {
    const canvas = drawingCanvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    // Sync canvas size with video size
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (result) {
      result.people.forEach(person => {
        const { x, y, width, height } = person.bounding_box;
        // Map 0-1000 to pixel values
        const pX = (x / 1000) * canvas.width;
        const pY = (y / 1000) * canvas.height;
        const pW = (width / 1000) * canvas.width;
        const pH = (height / 1000) * canvas.height;

        ctx.strokeStyle = person.is_hand_raised ? 'red' : 'blue';
        ctx.lineWidth = 4;
        ctx.strokeRect(pX, pY, pW, pH);
      });
    }
  }, [result]);

  // --- Start Camera ---
  useEffect(() => {
    async function setupCamera() {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
        setStream(mediaStream);
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
        }
      } catch (err) {
        console.error('Camera Error:', err);
        setError('Could not access webcam. Please ensure camera permissions are granted.');
      }
    }
    setupCamera();
    return () => {
      stream?.getTracks().forEach(track => track.stop());
    };
  }, []);

  // --- Dwell Time Counter ---
  useEffect(() => {
    let timer: number;
    if (dwellStartRef.current !== null) {
      timer = window.setInterval(() => {
        setDwellTime(Math.floor((Date.now() - dwellStartRef.current!) / 1000));
      }, 1000);
    } else {
      setDwellTime(0);
    }
    return () => clearInterval(timer);
  }, [dwellTime === 0]); // Re-run when reset

  // --- Analysis Loop ---
  useEffect(() => {
    if (!isAnalysisEnabled) {
      return;
    }

    const interval = setInterval(captureAndAnalyze, 10000);
    return () => {
      clearInterval(interval);
    };
  }, [stream, isAnalysisEnabled]);

  async function captureAndAnalyze() {
    if (!videoRef.current || !canvasRef.current || isAnalyzing || !stream) return;

    setIsAnalyzing(true);
    try {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(video, 0, 0);
      const base64Image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];

      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            parts: [
              {
                text: `Analyze this image and return EXACTLY a JSON object with this structure:
                {
                  "people_count": integer,
                  "people": [
                    {
                      "id": integer,
                      "gender": string,
                      "approximate_age": integer,
                      "movement_type": string,
                      "is_hand_raised": boolean,
                      "bounding_box": {
                        "x": integer,
                        "y": integer,
                        "width": integer,
                        "height": integer
                      }
                    }
                  ]
                }
                Assign a unique, consistent ID to each person detected. If a person leaves and returns, attempt to assign the same ID they had previously in this session.
                Zero people should return an empty array for "people".
                Bounding box coordinates (x, y, width, height) should be relative to the image size (0-1000).`
              },
              {
                inlineData: {
                  data: base64Image,
                  mimeType: 'image/jpeg'
                }
              }
            ]
          }
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              people_count: { type: Type.INTEGER },
              people: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.INTEGER },
                    gender: { type: Type.STRING },
                    approximate_age: { type: Type.INTEGER },
                    movement_type: { type: Type.STRING },
                    is_hand_raised: { type: Type.BOOLEAN },
                    bounding_box: {
                      type: Type.OBJECT,
                      properties: {
                        x: { type: Type.INTEGER },
                        y: { type: Type.INTEGER },
                        width: { type: Type.INTEGER },
                        height: { type: Type.INTEGER }
                      },
                      required: ['x', 'y', 'width', 'height']
                    }
                  },
                  required: ['id', 'gender', 'approximate_age', 'movement_type', 'is_hand_raised', 'bounding_box']
                }
              }
            },
            required: ['people_count', 'people']
          }
        }
      });

      const data = JSON.parse(response.text || '{}') as AnalysisResult;
      setResult(data);
      setLastJson(JSON.stringify(data, null, 2));

      // Dwell Time Logic
      if (data.people_count > 0) {
        setEmptyChecks(0);
        if (dwellStartRef.current === null) {
          dwellStartRef.current = Date.now();
        }
      } else {
        setEmptyChecks(prev => {
          const next = prev + 1;
          if (next >= 2) { // 2 consecutive empty checks (8 seconds)
            dwellStartRef.current = null;
            return 0;
          }
          return next;
        });
      }

    } catch (err) {
      console.error('Analysis failed:', err);
    } finally {
      setIsAnalyzing(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans selection:bg-orange-500/30">
      {/* Background Grid */}
      <div className="fixed inset-0 bg-[linear-gradient(to_right,#1a1a1a_1px,transparent_1px),linear-gradient(to_bottom,#1a1a1a_1px,transparent_1px)] bg-[size:40px_40px] pointer-events-none opacity-20" />
      
      <main className="relative z-10 max-w-7xl mx-auto p-4 md:p-8 flex flex-col gap-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-zinc-800 pb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tighter flex items-center gap-2">
              <Activity className="text-orange-500 w-8 h-8" />
              VISION_TRACKER v1.0
            </h1>
            <p className="text-zinc-500 font-mono text-sm uppercase tracking-widest mt-1">
              Gemini Multimodal Real-Time Analysis
            </p>
          </div>
          <div className="flex gap-4">
            <button
              onClick={() => setIsAnalysisEnabled(!isAnalysisEnabled)}
              className={`px-4 py-2 rounded-lg flex items-center gap-2 text-xs font-mono uppercase transition-colors ${
                isAnalysisEnabled 
                  ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/50' 
                  : 'bg-green-500/10 text-green-400 hover:bg-green-500/20 border border-green-500/50'
              }`}
            >
              {isAnalysisEnabled ? <><Square className="w-3 h-3" /> STOP</> : <><Play className="w-3 h-3" /> START</>}
            </button>
            <div className="bg-zinc-900 border border-zinc-800 px-4 py-2 rounded-lg flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${stream ? 'bg-green-500 shadow-[0_0_8px_#22c55e]' : 'bg-red-500'} animate-pulse`} />
              <span className="text-xs font-mono uppercase tracking-tighter text-zinc-400">
                SENSOR: {stream ? 'ACTIVE' : 'OFFLINE'}
              </span>
            </div>
            <CountdownTimer isAnalysisEnabled={isAnalysisEnabled} isAnalyzingRef={isAnalyzingRef} />
          </div>
        </header>

        {error && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-red-500/10 border border-red-500/50 p-4 rounded-xl flex items-center gap-3 text-red-400"
          >
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p className="text-sm">{error}</p>
          </motion.div>
        )}

        
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Main Feed - Video */}
          <div className="lg:col-span-8 space-y-6">
            <div className="relative aspect-video bg-zinc-900 rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl group">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover scale-x-[-1]"
              />
              <canvas ref={canvasRef} className="hidden" />
              <canvas ref={drawingCanvasRef} className="absolute inset-0 w-full h-full object-cover scale-x-[-1] pointer-events-none" />
              
              {/* UI Overlay on Video */}
              <div className="absolute inset-x-0 bottom-0 p-6 bg-gradient-to-t from-black/80 to-transparent flex justify-between items-end">
                <div className="flex flex-col gap-2">
                  <AnimatePresence>
                    {isAnalyzing && (
                      <motion.div 
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -10 }}
                        className="flex items-center gap-2 text-orange-400 text-xs font-mono"
                      >
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        PROCESSING FRAME...
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-white/10 backdrop-blur-md rounded-full border border-white/20">
                      <Users className="w-4 h-4 text-white" />
                      <span className="text-sm font-bold text-white leading-none">
                        {result?.people_count || 0} People
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Sidebar - Cards + JSON */}
          <aside className="lg:col-span-4 space-y-6">
            {/* Person Cards */}
            <div className="space-y-4">
              <AnimatePresence mode="popLayout">
                {result?.people.map((person) => (
                  <motion.div
                    key={person.id}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="bg-zinc-900 border border-zinc-800 p-4 rounded-xl flex items-start gap-4 hover:border-zinc-600 transition-colors"
                  >
                    <div className="w-10 h-10 bg-zinc-800 rounded-lg flex items-center justify-center text-orange-500 font-bold">
                      {person.id}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-xs font-mono text-zinc-500 uppercase">Subject {person.id}</span>
                        <span className="text-xs bg-orange-500/20 text-orange-400 px-2 py-0.5 rounded uppercase font-bold">ID_{person.id}</span>
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium">Gender: <span className="text-zinc-400">{person.gender}</span></p>
                        <p className="text-sm font-medium">Age: <span className="text-zinc-400">~{person.approximate_age}</span></p>
                        <p className="text-sm font-medium">Status: <span className="text-zinc-400 italic">"{person.movement_type}"</span></p>
                        <p className="text-sm font-medium">Dwell Time: <span className="text-zinc-400">{dwellTime}s</span></p>
                        <div className="mt-2 flex items-center gap-1.5 text-xs font-medium">
                          {person.is_hand_raised ? (
                            <span className="flex items-center gap-1 text-red-400 bg-red-400/10 px-2 py-0.5 rounded">
                              ✋ Hand Raised
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">
                              No hand raised
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              {(!result || result.people_count === 0) && (
                <div className="border border-dashed border-zinc-800 rounded-xl p-12 flex flex-col items-center justify-center text-zinc-600 grayscale">
                  <Users className="w-12 h-12 mb-4 opacity-20" />
                  <p className="text-sm font-mono uppercase tracking-widest text-center">Waiting for detection...</p>
                </div>
              )}
            </div>
            
            <div className="bg-[#121212] border border-zinc-800 rounded-2xl overflow-hidden shadow-xl">
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900/50">
                <div className="flex items-center gap-2">
                  <Code className="w-4 h-4 text-zinc-400" />
                  <span className="text-xs font-mono font-bold text-zinc-300 uppercase tracking-tighter">JSON_OUTPUT</span>
                </div>
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/20" />
                  <div className="w-2.5 h-2.5 rounded-full bg-orange-500/20" />
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500/20" />
                </div>
              </div>
              <div className="p-4 bg-zinc-950/50">
                <pre className="text-[11px] font-mono text-zinc-400 overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-[400px] custom-scrollbar">
                  {lastJson || '// Waiting for API response (Interval: 10s)'}
                </pre>
              </div>
            </div>
          </aside>
        </div>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #3f3f46;
        }
      `}</style>
    </div>
  );
}
