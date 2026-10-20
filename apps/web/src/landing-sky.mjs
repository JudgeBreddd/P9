// The landing page's black hole (Builder, 2026-10-19: "Event Horizon effect using the brand pack as reference"): each pixel's
// light ray is bent around a Schwarzschild hole (radius 1) on its way out, so the far side of the accretion disk shows above
// and below the shadow, as in docs/brand/p9-image-pack.png. Gold-to-violet disk, a blue photon ring, a blue-violet sky.
// WebGL 1 only; with no WebGL the canvas keeps its CSS fallback and `ok` is false.
const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const FRAG = `precision highp float;
uniform vec2 uRes;uniform float uTime,uSpin,uDist,uShift,uIgnite,uStars,uDim;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
vec3 sky(vec3 d){
  vec2 s=vec2(atan(d.z,d.x),asin(clamp(d.y,-1.,1.)));
  vec2 g=s*vec2(70.,70.),id=floor(g),f=fract(g)-.5;float h=hash(id);
  vec2 o=(vec2(hash(id+1.3),hash(id+2.7))-.5)*.6;
  float star=step(.972,h)*smoothstep(.1,0.,length(f-o))*(.55+.45*sin(uTime*1.7+h*60.))*(h>.996?2.2:1.);
  vec2 g2=s*180.,f2=fract(g2)-.5;float h3=hash(floor(g2));star+=step(.985,h3)*smoothstep(.12,0.,length(f2))*.45;
  float n=fbm(s*vec2(1.3,2.6)+vec2(uTime*.004,0.)),m=fbm(s*vec2(2.7,5.)-n*1.4);
  float band=exp(-pow(d.y*3.2-.35*sin(s.x*1.3+.6),2.)*2.2);
  vec3 neb=mix(vec3(.05,.1,.42),vec3(.36,.14,.62),m)*pow(n,3.2)*band*.9;
  return (vec3(star)*vec3(.85,.9,1.)+neb)*uStars;
}
vec4 disk(vec3 p,float r,vec3 dir){
  float t=(r-2.4)/9.6;if(t<0.||t>1.)return vec4(0.);
  float a=atan(p.z,p.x)+uSpin*2.6/pow(r,1.5);
  vec2 q=vec2(r*2.8,0.)+vec2(cos(a),sin(a))*1.9;
  vec2 w=vec2(r*1.1,0.)+vec2(cos(a),sin(a))*6.;
  float n=fbm(q)*.6+fbm(q*3.1+5.)*.35+fbm(w)*.3;
  float dens=smoothstep(0.,.035,t)*pow(1.-t,2.)*(.12+pow(n,2.4)*2.2);
  vec3 c=mix(vec3(1.,.93,.8),vec3(1.,.58,.18),smoothstep(.0,.22,t));
  c=mix(c,vec3(.3,.42,1.),smoothstep(.3,.62,t));
  c=mix(c,vec3(.52,.28,.92),smoothstep(.62,1.,t));
  float dop=dot(normalize(vec3(-p.z,0.,p.x)),-normalize(dir));
  c*=pow(1.+.5*dop,3.);
  float on=smoothstep(t*.85,t*.85+.2,uIgnite);
  return vec4(c*dens*2.4*on,clamp(dens*1.6,0.,1.)*on);
}
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*uRes)/uRes.y-vec2(0.,uShift);
  float inc=.085,roll=-.07;
  uv=mat2(cos(roll),-sin(roll),sin(roll),cos(roll))*uv;
  vec3 pos=vec3(0.,sin(inc),-cos(inc))*uDist;
  vec3 fw=normalize(-pos),rt=normalize(cross(vec3(0.,1.,0.),fw)),up=cross(fw,rt);
  vec3 dir=normalize(uv.x*rt+uv.y*up+1.6*fw);
  vec3 hv=cross(pos,dir);float h2=dot(hv,hv);
  // b: how far the ray passes outside the shadow's edge (3*sqrt(3)/2), in units where one pixel is px.
  float b=sqrt(h2)-2.598,px=uDist/(1.6*uRes.y);float cross1=0.;
  vec3 col=vec3(0.);float alpha=0.;bool caught=false;
  for(int i=0;i<140;i++){
    float r=length(pos);
    if(r<1.){caught=true;break;}
    if(r>uDist+8.||alpha>.98)break;
    float dt=clamp(.07*r,.02,1.2);
    vec3 prev=pos;
    dir+=-1.5*h2*pos/pow(r,5.)*dt;pos+=dir*dt;
    if(prev.y*pos.y<0.){vec3 hit=mix(prev,pos,prev.y/(prev.y-pos.y));
      // The disk's second and later images hug the edge thinner than a pixel; they fade there instead of speckling.
      vec4 d=disk(hit,length(hit.xz),dir)*(cross1>0.?smoothstep(px,8.*px,b):1.);cross1=1.;
      col+=(1.-alpha)*d.rgb;alpha+=(1.-alpha)*d.a;}
  }
  // The shadow's edge comes from the ray's impact parameter (captured below 3*sqrt(3)/2), smoothed over one pixel, not from
  // where the march stepped inside: that left a dotted rim. The photon ring's glow follows the same parameter.
  float lit=(1.-alpha)*smoothstep(-px,px,b);
  col+=lit*(caught?vec3(0.):sky(normalize(dir)));
  col+=lit*vec3(.55,.7,1.)*exp(-max(b,0.)*7.)*.55*uIgnite;
  col+=lit*vec3(.1,.14,.5)*exp(-max(b,0.)*.2)*.45*uIgnite;
  col=1.-exp(-col*1.25);
  gl_FragColor=vec4(pow(col,vec3(.92))*uDim,1.);
}`;

export function createSky(canvas) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  if (!gl) return { ok: false, set() {}, frame() {}, size() {} };
  const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { ok: false, set() {}, frame() {}, size() {} };
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const u = Object.fromEntries(['uRes', 'uTime', 'uSpin', 'uDist', 'uShift', 'uIgnite', 'uStars', 'uDim'].map(n => [n, gl.getUniformLocation(prog, n)]));
  const v = { uTime: 0, uSpin: 0, uDist: 22, uShift: 0, uIgnite: 1, uStars: 1, uDim: 1 };
  let scale = 1;
  return {
    ok: true,
    set(values) { Object.assign(v, values); },
    // Draw at `s` of the canvas's CSS size (times the screen's pixel ratio, at most 2); the browser scales it up smoothly.
    size(s) { scale = s; },
    frame() {
      const r = Math.min(devicePixelRatio || 1, 2) * scale, w = Math.max(1, Math.round(canvas.clientWidth * r)), h = Math.max(1, Math.round(canvas.clientHeight * r));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(u.uRes, w, h);
      for (const k of Object.keys(v)) gl.uniform1f(u[k], v[k]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}
