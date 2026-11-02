import numpy as np, onnxruntime as ort, soundfile as sf, base64, sys, json
def mel_filters(sr=16000,n_fft=400,n_mels=80):
    def hz2mel(f):
        f=np.asanyarray(f,dtype=float); m=f/(200.0/3); lin=1000.0; minlog=lin/(200.0/3); step=np.log(6.4)/27.0
        return np.where(f>=lin, minlog+np.log(np.maximum(f,1e-10)/lin)/step, m)
    def mel2hz(m):
        m=np.asanyarray(m,dtype=float); f=(200.0/3)*m; lin=1000.0; minlog=lin/(200.0/3); step=np.log(6.4)/27.0
        return np.where(m>=minlog, lin*np.exp(step*(m-minlog)), f)
    fft=np.linspace(0,sr/2,1+n_fft//2); mels=mel2hz(np.linspace(hz2mel(0),hz2mel(sr/2),n_mels+2))
    fd=np.diff(mels); ramps=mels[:,None]-fft[None,:]; w=np.zeros((n_mels,1+n_fft//2))
    for i in range(n_mels):
        lo=-ramps[i]/fd[i]; up=ramps[i+2]/fd[i+1]; w[i]=np.maximum(0,np.minimum(lo,up))
    w*=(2.0/(mels[2:n_mels+2]-mels[:n_mels]))[:,None]; return w.astype(np.float32)
FB=mel_filters()
def logmel(x):
    x=np.pad(x,(0,max(0,480000-len(x))))[:480000]
    xp=np.pad(x,(200,200),mode='reflect'); win=(0.5-0.5*np.cos(2*np.pi*np.arange(400)/400)).astype(np.float32)
    n=1+(len(xp)-400)//160; fr=np.stack([xp[i*160:i*160+400]*win for i in range(n)])
    p=np.abs(np.fft.rfft(fr,axis=1))**2; p=p[:-1]
    m=FB@p.T; lg=np.log10(np.maximum(m,1e-10)); lg=np.maximum(lg,lg.max()-8.0); return ((lg+4)/4).astype(np.float32)
def run(prefix,wav):
    x,sr=sf.read(wav,dtype='float32'); assert sr==16000
    enc=ort.InferenceSession(prefix+'-encoder.int8.onnx'); dec=ort.InferenceSession(prefix+'-decoder.int8.onnx')
    md=enc.get_modelmeta().custom_metadata_map; L=int(md['n_text_layer']); S=int(md['n_text_state'])
    ck,cv=enc.run(None,{'mel':logmel(x)[None]})
    sk=np.zeros((L,1,448,S),np.float32); sv=np.zeros_like(sk)
    toks=[int(md['sot']),int(md['no_timestamps'])]; out=[]; off=0; cur=toks
    for _ in range(200):
        lg,sk,sv=dec.run(None,{'tokens':np.array([cur],np.int64),'in_n_layer_self_k_cache':sk,'in_n_layer_self_v_cache':sv,'n_layer_cross_k':ck,'n_layer_cross_v':cv,'offset':np.array([off],np.int64)})
        off+=len(cur); t=int(lg[0,-1].argmax())
        if t==int(md['eot']): break
        out.append(t); cur=[t]
    tok={}
    for line in open(prefix+'-tokens.txt'):
        a=line.split()
        if len(a)==2: tok[int(a[1])]=base64.b64decode(a[0])
    return b''.join(tok.get(t,b'') for t in out).decode('utf-8','ignore').strip()
if __name__=='__main__':
    print(run(sys.argv[1],sys.argv[2]))
    np.save('tools/melfb.npy',FB)
