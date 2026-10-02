// 49_webaudio_surface.js — the shape of the Web Audio interfaces in Chromium 140: constructor length, own names of the prototype in
// their order and the length of every operation (scripts hash Object.getOwnPropertyNames). Members this implementation lacks are skipped.
(function (L) {
  'use strict';
  const SURFACE = {"BaseAudioContext":[0,"destination:a sampleRate:a currentTime:a listener:a state:a onstatechange:a createAnalyser:0 createBiquadFilter:0 createBuffer:3 createBufferSource:0 createChannelMerger:0 createChannelSplitter:0 createConstantSource:0 createConvolver:0 createDelay:0 createDynamicsCompressor:0 createGain:0 createIIRFilter:2 createOscillator:0 createPanner:0 createPeriodicWave:2 createScriptProcessor:0 createStereoPanner:0 createWaveShaper:0 decodeAudioData:1 constructor:0"],"AudioContext":[0,"baseLatency:a outputLatency:a close:0 createMediaElementSource:1 createMediaStreamDestination:0 createMediaStreamSource:1 getOutputTimestamp:0 resume:0 suspend:0 onerror:a constructor:0"],"OfflineAudioContext":[1,"oncomplete:a length:a resume:0 startRendering:0 suspend:1 constructor:1"],"OfflineAudioCompletionEvent":[2,"renderedBuffer:a constructor:2"],"AudioBuffer":[1,"length:a duration:a sampleRate:a numberOfChannels:a copyFromChannel:2 copyToChannel:2 getChannelData:1 constructor:1"],"AudioNode":[0,"context:a numberOfInputs:a numberOfOutputs:a channelCount:a channelCountMode:a channelInterpretation:a connect:1 disconnect:0 constructor:0"],"AudioParam":[0,"value:a automationRate:a defaultValue:a minValue:a maxValue:a cancelAndHoldAtTime:1 cancelScheduledValues:1 exponentialRampToValueAtTime:2 linearRampToValueAtTime:2 setTargetAtTime:3 setValueAtTime:2 setValueCurveAtTime:3 constructor:0"],"AudioDestinationNode":[0,"maxChannelCount:a constructor:0"],"AudioListener":[0,"positionX:a positionY:a positionZ:a forwardX:a forwardY:a forwardZ:a upX:a upY:a upZ:a setOrientation:6 setPosition:3 constructor:0"],"OscillatorNode":[1,"type:a frequency:a detune:a setPeriodicWave:1 constructor:1"],"GainNode":[1,"gain:a constructor:1"],"DynamicsCompressorNode":[1,"threshold:a knee:a ratio:a reduction:a attack:a release:a constructor:1"],"AnalyserNode":[1,"fftSize:a frequencyBinCount:a minDecibels:a maxDecibels:a smoothingTimeConstant:a getByteFrequencyData:1 getByteTimeDomainData:1 getFloatFrequencyData:1 getFloatTimeDomainData:1 constructor:1"],"BiquadFilterNode":[1,"type:a frequency:a detune:a Q:a gain:a getFrequencyResponse:3 constructor:1"],"AudioBufferSourceNode":[1,"buffer:a playbackRate:a detune:a loop:a loopStart:a loopEnd:a start:0 constructor:1"],"ConstantSourceNode":[1,"offset:a constructor:1"],"ChannelSplitterNode":[1,"constructor:1"],"ChannelMergerNode":[1,"constructor:1"],"StereoPannerNode":[1,"pan:a constructor:1"],"DelayNode":[1,"delayTime:a constructor:1"],"WaveShaperNode":[1,"curve:a oversample:a constructor:1"],"IIRFilterNode":[2,"getFrequencyResponse:3 constructor:2"],"PeriodicWave":[1,"constructor:1"],"ScriptProcessorNode":[0,"onaudioprocess:a bufferSize:a constructor:0"],"AudioProcessingEvent":[2,"playbackTime:a inputBuffer:a outputBuffer:a constructor:2"],"AudioScheduledSourceNode":[0,"onended:a start:0 stop:0 constructor:0"]};
  for (const [name, [len, members]] of Object.entries(SURFACE)) {
    const entry = L.exposed.find((e) => e[0] === name);
    if (entry === undefined) continue;
    const cls = entry[1];
    Object.defineProperty(cls, 'length', { value: len, configurable: true });
    const keys = [];
    for (const m of members.split(' ')) {
      const [k, v] = m.split(':');
      const d = Reflect.getOwnPropertyDescriptor(cls.prototype, k);
      if (d === undefined) continue;
      keys.push(k);
      if (k !== 'constructor' && typeof d.value === 'function' && v !== 'a') Object.defineProperty(d.value, 'length', { value: +v, configurable: true });
    }
    L.orderKeys(cls.prototype, keys);
  }
})(globalThis.__layer);
