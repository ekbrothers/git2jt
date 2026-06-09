// Quick smoke test for the pure-JS GIF parser
const fs = require('fs');

function parseGif(data){
  let pos=0;
  const u8=()=>data[pos++];
  const u16=()=>{const v=data[pos]|(data[pos+1]<<8);pos+=2;return v;};
  pos=6;
  const canvasW=u16(),canvasH=u16();
  const packed=u8();
  const hasgct=packed>>7;
  const gctSize=2<<(packed&7);
  u8();u8();
  const gct=hasgct?readColorTable(gctSize):null;

  function readColorTable(n){
    const t=[];for(let i=0;i<n;i++){t.push([data[pos],data[pos+1],data[pos+2]]);pos+=3;}return t;
  }
  function skipSubBlocks(){let sz;while((sz=u8())!==0)pos+=sz;}

  const frames=[];
  let canvas=new Uint8ClampedArray(canvasW*canvasH*4);
  let gcDelay=100,gcDisposal=0,gcTransIdx=-1;

  while(pos<data.length){
    const sentinel=u8();
    if(sentinel===0x3b)break;
    if(sentinel===0x21){
      const label=u8();
      if(label===0xf9){
        u8();const p=u8();gcDisposal=(p>>2)&7;const hasTransp=p&1;
        gcDelay=u16()*10;gcTransIdx=hasTransp?u8():-1;if(!hasTransp)u8();u8();
      } else { skipSubBlocks(); }
      continue;
    }
    if(sentinel===0x2c){
      const left=u16(),top=u16(),fw=u16(),fh=u16();
      const p=u8();const haslct=p>>7;const interlace=(p>>6)&1;const lctSize=2<<(p&7);
      const ct=haslct?readColorTable(lctSize):(gct||[]);
      const minCode=u8();
      let rawBytes=[];let sz;while((sz=u8())!==0){for(let i=0;i<sz;i++)rawBytes.push(data[pos+i]);pos+=sz;}
      const indices=lzwDecode(new Uint8Array(rawBytes),minCode);
      const prevCanvas=new Uint8ClampedArray(canvas);
      let idx=0;
      for(let row=0;row<fh;row++){
        const y=interlace?deinterlaceRow(row,fh):row;
        for(let col=0;col<fw;col++){
          const ci=indices[idx++];if(ci===gcTransIdx)continue;
          const [r,g,b]=ct[ci]||[0,0,0];
          const off=((top+y)*canvasW+(left+col))*4;
          canvas[off]=r;canvas[off+1]=g;canvas[off+2]=b;canvas[off+3]=255;
        }
      }
      frames.push({width:canvasW,height:canvasH,delay:gcDelay||100,pixelCount:canvasW*canvasH});
      if(gcDisposal===2){for(let y=0;y<fh;y++)for(let x=0;x<fw;x++){const off=((top+y)*canvasW+(left+x))*4;canvas[off]=canvas[off+1]=canvas[off+2]=canvas[off+3]=0;}}
      else if(gcDisposal===3){canvas=prevCanvas;}
      gcDisposal=0;gcTransIdx=-1;gcDelay=100;
      continue;
    }
    break;
  }
  return frames;
}

function deinterlaceRow(row,height){
  const passes=[{start:0,step:8},{start:4,step:8},{start:2,step:4},{start:1,step:2}];
  let out=0;
  for(const {start,step} of passes){for(let y=start;y<height;y+=step){if(out===row)return y;out++;}}
  return row;
}

function lzwDecode(data,minCodeSize){
  const clearCode=1<<minCodeSize,eofCode=clearCode+1;
  let codeSize=minCodeSize+1,nextCode=eofCode+1;
  const table=[];
  for(let i=0;i<clearCode;i++)table[i]=[i];
  table[clearCode]=null;table[eofCode]=null;
  let bitBuf=0,bitLen=0,bytePos=0;
  const readCode=()=>{
    while(bitLen<codeSize&&bytePos<data.length){bitBuf|=data[bytePos++]<<bitLen;bitLen+=8;}
    const code=bitBuf&((1<<codeSize)-1);bitBuf>>=codeSize;bitLen-=codeSize;return code;
  };
  const out=[];let prev=null;
  while(true){
    const code=readCode();if(code===eofCode)break;
    if(code===clearCode){table.length=eofCode+1;codeSize=minCodeSize+1;nextCode=eofCode+1;prev=null;continue;}
    let entry;
    if(code<table.length&&table[code])entry=table[code];
    else if(code===nextCode&&prev)entry=[...prev,prev[0]];
    else break;
    out.push(...entry);
    if(prev&&nextCode<4096){table[nextCode++]=[...prev,entry[0]];if(nextCode>=(1<<codeSize)&&codeSize<12)codeSize++;}
    prev=entry;
  }
  return out;
}

// Test all 5 sample GIFs
const samples = ['fire','rainbow','matrix','pulse','nyancat'];
let allPass = true;
for(const name of samples){
  const data = new Uint8Array(fs.readFileSync(`public/${name}.gif`));
  const sig = String.fromCharCode(data[0],data[1],data[2],data[3],data[4],data[5]);
  if(!sig.startsWith('GIF')){console.log(`FAIL ${name}: not a GIF`);allPass=false;continue;}
  const frames = parseGif(data);
  if(!frames.length){console.log(`FAIL ${name}: 0 frames`);allPass=false;continue;}
  const ok = frames.every(f=>f.width>0&&f.height>0&&f.pixelCount>0);
  console.log(`${ok?'PASS':'FAIL'} ${name}.gif — ${frames.length} frames, ${frames[0].width}x${frames[0].height}, delay=${frames[0].delay}ms`);
  if(!ok)allPass=false;
}
console.log(allPass?'\nAll passed':'\nSome FAILED');
