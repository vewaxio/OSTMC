import React, { useState, useRef } from "react";
import JSZip from "jszip";
import "./App.css";
const KEY_COUNT = 4;
const HOLD_LENGTH_BEATS = 0; // 0 will produce normal notes
const STARTING_LANE = 1;
const LEFT_TO_RIGHT = true;
const EQUALISE_SV = true;

function findMode(fileText: string): number {
  const match = fileText.match(/Mode:[^\r\n]*/);
  return match ? parseInt(match[0].substring(5).trim(), 10) : 0;
}

function unbindBeatmapIds(fileText: string): string {
  let newText = fileText.replace(/BeatmapID:[^\r\n]*/g, "BeatmapID:-1");
  newText = newText.replace(/BeatmapSetID:[^\r\n]*/g, "BeatmapSetID:-1");
  return newText;
}

function changeMode(fileText: string, mode: number): string {
  const modeMatch = fileText.match(/Mode:[^\r\n]*/);
  if (!modeMatch) {
    const generalMatch = fileText.match(/\[General\][^\r\n]*/);
    if (!generalMatch) return fileText;
    const insertPos = (generalMatch.index || 0) + generalMatch[0].length;
    return fileText.substring(0, insertPos) + `\r\nMode: ${mode}` + fileText.substring(insertPos);
  }
  return fileText.replace(/Mode:[^\r\n]*/, `Mode: ${mode}`);
}

function changeLaneCount(fileText: string, laneCount: number): string {
  const match = fileText.match(/CircleSize:[^\r\n]*/);
  if (!match) return fileText;
  return fileText.replace(/CircleSize:[^\r\n]*/, `CircleSize: ${laneCount}`);
}

function changeDiffName(fileText: string): string {
  const regex = /Version:([^\r\n]*)/;
  const match = fileText.match(regex);
  if (!match) return fileText;
  return fileText.replace(regex, "Version:mania $1");
}

function fillList<T>(target: T[], fillValue: T, maxLength: number): T[] {
  const res = [...target];
  while (res.length < maxLength) {
    res.push(fillValue);
  }
  return res;
}

function findTimingPoints(fileText: string): { timingPoints: string[][]; span: [number, number] } {
  const regex = /\[TimingPoints\]\s*([\s\S]*?)(?=\r?\n\[|$)/;
  const match = regex.exec(fileText);
  if (!match) return { timingPoints: [], span: [0, 0] };

  const spanStart = match.index;
  const spanEnd = spanStart + match[0].length;

  const text = match[1].trim();
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const timingPoints = lines.map(line => fillList(line.trim().split(','), '1', 8));

  return { timingPoints, span: [spanStart, spanEnd] };
}

function findBaseSv(fileText: string): number {
  const match = fileText.match(/SliderMultiplier:([^\r\n]*)/);
  return match ? parseFloat(match[1].trim()) : 1.4;
}

function findTimingValue(targetTime: number, timestampedValues: [number, number][]): number {
  for (let i = 0; i < timestampedValues.length; i++) {
    const nextTime = i + 1 < timestampedValues.length ? timestampedValues[i + 1][0] : Infinity;
    if (nextTime > targetTime) {
      return timestampedValues[i][1];
    }
  }
  return timestampedValues.length > 0 ? timestampedValues[timestampedValues.length - 1][1] : 1;
}

function maniaXPosition(hitobjectIndex: number): number {
  const PLAYFIELD_WIDTH = 512;
  let lane = 0;
  if (LEFT_TO_RIGHT) {
    lane = (STARTING_LANE - 1 + hitobjectIndex) % KEY_COUNT;
  } else {
    lane = (STARTING_LANE - 1 - hitobjectIndex) % KEY_COUNT;
    if (lane < 0) lane += KEY_COUNT;
  }
  return Math.ceil(PLAYFIELD_WIDTH * (lane / KEY_COUNT));
}

function changeHitobject(
  hitobjectIndex: number,
  hitobject: string[],
  baseSv: number,
  sliderMultipliers: [number, number][],
  beatLengths: [number, number][]
): string[] {
  const HITCIRCLE_BIT = 0;
  const SLIDER_BIT = 1;
  const SPINNER_BIT = 3;
  const MANIA_HOLD_BIT = 7;
  const MANIA_HOLD_TYPE = (2 ** MANIA_HOLD_BIT).toString(); // "128"

  const time = parseInt(hitobject[2], 10);
  const type_ = parseInt(hitobject[3], 10);

  const isHitCircle = (type_ & (1 << HITCIRCLE_BIT)) !== 0;
  const isSlider = (type_ & (1 << SLIDER_BIT)) !== 0;
  const isSpinner = (type_ & (1 << SPINNER_BIT)) !== 0;

  const beatLength = findTimingValue(time, beatLengths);
  let newHitobject = [...hitobject];

  if (isHitCircle) {
    if (HOLD_LENGTH_BEATS === 0) {
      newHitobject = [...hitobject];
    } else {
      newHitobject = [...hitobject.slice(0, 5), (time + beatLength * HOLD_LENGTH_BEATS).toString()];
      newHitobject[3] = MANIA_HOLD_TYPE;
    }
  } else if (isSlider) {
    const slides = parseInt(hitobject[6], 10);
    const length = parseFloat(hitobject[7]);
    const svMultiplier = findTimingValue(time, sliderMultipliers);
    const sliderVelocity = baseSv * svMultiplier;

    const endTime = time + (beatLength * slides * length) / (100 * sliderVelocity);
    newHitobject = [...hitobject.slice(0, 5), Math.round(endTime).toString()];
    newHitobject[3] = MANIA_HOLD_TYPE;
  } else if (isSpinner) {
    newHitobject[3] = MANIA_HOLD_TYPE;
  }

  newHitobject[0] = maniaXPosition(hitobjectIndex).toString();
  return newHitobject;
}

function changeHitobjects(fileText: string, hitobjects: string[][]): string[][] {
  const { timingPoints } = findTimingPoints(fileText);
  let sliderMultipliers: [number, number][] = [];
  const beatLengths: [number, number][] = [];

  for (const tp of timingPoints) {
    const time = parseFloat(tp[0]);
    const beatLength = parseFloat(tp[1]);
    const uninherited = parseInt(tp[6], 10);
    if (!uninherited) {
      sliderMultipliers.push([time, -100 / beatLength]);
    } else {
      beatLengths.push([time, beatLength]);
    }
  }

  if (sliderMultipliers.length === 0) sliderMultipliers = [[0, 1]];

  const baseSv = findBaseSv(fileText);
  return hitobjects.map((hitobject, index) =>
    changeHitobject(index, hitobject, baseSv, sliderMultipliers, beatLengths)
  );
}

function changeHitobjectText(fileText: string): string {
  const regex = /\[HitObjects\]\s*([\s\S]*?)(?=\r?\n\[|$)/;
  const match = regex.exec(fileText);
  if (!match) return fileText;

  const spanStart = match.index;
  const spanEnd = spanStart + match[0].length;
  
  const text = match[1].trim();
  const hitobjects = text.split(/\r?\n/).filter(l => l.trim().length > 0).map(l => l.trim().split(','));

  if (hitobjects.length === 0) return fileText;

  const newHitobjects = changeHitobjects(fileText, hitobjects);
  const hitobjectText = newHitobjects.map(ho => ho.join(',')).join('\r\n');

  return fileText.substring(0, spanStart) + "[HitObjects]\r\n" + hitobjectText + "\r\n\r\n" + fileText.substring(spanEnd);
}

function changeSliderMultipliers(fileText: string): string {
  const DEFAULT_SLIDERMULTIPLIER = '-100';
  const { timingPoints, span } = findTimingPoints(fileText);
  if (timingPoints.length === 0) return fileText;

  for (const tp of timingPoints) {
    const uninherited = parseInt(tp[6], 10);
    if (!uninherited) {
      tp[1] = DEFAULT_SLIDERMULTIPLIER;
    }
  }

  const timingText = timingPoints.map(tp => tp.join(',')).join('\r\n');
  return fileText.substring(0, span[0]) + "[TimingPoints]\r\n" + timingText + "\r\n\r\n" + fileText.substring(span[1]);
}

function convertOsuText(fileText: string): string | null {
  const mode = findMode(fileText);
  if (mode !== 0) {
    console.log("Not a standard diff");
    return null;
  }

  let newText = fileText;

  newText = changeHitobjectText(newText);
  newText = changeMode(newText, 3);
  newText = changeLaneCount(newText, KEY_COUNT);
  newText = changeDiffName(newText);
  newText = unbindBeatmapIds(newText);

  if (EQUALISE_SV) {
    newText = changeSliderMultipliers(newText);
  }

  return newText;
}

import { Upload, CheckCircle, Loader2 } from "lucide-react";

const MyFileDropper = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processOsz(e.target.files[0]);
    }
    // Reset value so the same file can be selected again if needed
    e.target.value = "";
  };

  const processOsz = async (file: File) => {
    setIsProcessing(true);
    setSuccessMsg("");
    try {
      const zip = new JSZip();
      const loadedZip = await zip.loadAsync(file);
      const newZip = new JSZip();

      let convertedCount = 0;
      for (const [relativePath, zipEntry] of Object.entries(loadedZip.files)) { 
        if (relativePath.endsWith(".osu")) {
          const text = await zipEntry.async("string");
          const convertedText = convertOsuText(text);
          if (convertedText) {
            const newFilename = relativePath.replace(".osu", "[mania].osu");    
            newZip.file(newFilename, convertedText);
            convertedCount++;
          }
        } else {
          const blob = await zipEntry.async("blob");
          newZip.file(relativePath, blob);
        }
      }

      const newContent = await newZip.generateAsync({ type: "blob" });
      const downloadUrl = URL.createObjectURL(newContent);

      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = file.name.replace(".osz", "[mania].osz");
      a.click();
      URL.revokeObjectURL(downloadUrl);
      
      setSuccessMsg(`Converted ${convertedCount} difficulties successfully!`);
      setTimeout(() => setSuccessMsg(""), 5000);
    } catch (err) {
      console.error(err);
      alert("Error processing the osz file. See console for details.");
    } finally {
      setIsProcessing(false);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processOsz(e.dataTransfer.files[0]);
    }
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  return (
    <div className="w-full max-w-2xl mx-auto mt-8">
      <input
        type="file"
        accept=".osz"
        className="hidden"
        title="File upload"
        ref={fileInputRef}
        onChange={handleFileSelect}
      />
      <div
        onClick={() => fileInputRef.current?.click()}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={`flex flex-col items-center justify-center p-12 border-2 border-dashed rounded-lg transition-colors ${
          isDragging 
            ? "border-[#ff4f9a] bg-[#ff4f9a]/10" 
            : "border-gray-600 hover:border-gray-500 bg-[#16161a]"
        } ${isProcessing ? "opacity-75 pointer-events-none" : "cursor-pointer"}`}
      >
        {isProcessing ? (
          <Loader2 className="w-12 h-12 text-[#ff4f9a] animate-spin mb-4" />
        ) : successMsg ? (
          <CheckCircle className="w-12 h-12 text-[#ff4f9a] mb-4" />
        ) : (
          <Upload className={`w-12 h-12 mb-4 ${isDragging ? "text-[#ff4f9a]" : "text-gray-400"}`} />
        )}

        <h3 className="text-xl font-semibold text-white mb-2">
          {isProcessing ? "Converting map..." : successMsg ? "Finished!" : "Drop your .osz file, or click here"}
        </h3>
        
        <p className="text-gray-400 text-center">
          {isProcessing 
            ? "Creating your 4-key mania map archive" 
            : successMsg 
            ? successMsg 
            : "Instantly translate standard patterns into mania"}
        </p>
      </div>
    </div>
  );
};

function App() {
  return (
    <main className="min-h-screen bg-[#0b0b0f] text-gray-100 font-sans flex flex-col items-center justify-center p-6">
      <div className="max-w-3xl w-full flex flex-col items-center">
        
        <div className="text-center mb-8">
          <span className="inline-block px-3 py-1 mb-4 text-xs font-semibold text-[#ff4f9a] bg-[#ff4f9a]/10 border border-[#ff4f9a]/20 rounded-full">
            Client-Side Converter
          </span>
          <h1 className="text-4xl md:text-5xl font-bold mb-4 text-white">
            osu! Standard to <span className="text-[#ff4f9a]">Mania</span>
          </h1>
          <p className="text-gray-400 max-w-lg mx-auto">
            Drop any standard osu! mapset below. It translates hit circles and sliders directly into a fully playable 4-key mania map.
          </p>
        </div>

        <MyFileDropper />

        <footer className="mt-12 text-sm text-gray-500 flex items-center gap-2">
          <span>Runs entirely in your browser</span>
          <span className="w-1 h-1 rounded-full bg-gray-500" />
          <span>No server uploads</span>
        </footer>
      </div>
    </main>
  );
}

export default App;
