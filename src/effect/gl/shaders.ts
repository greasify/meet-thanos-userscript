export const FULLSCREEN_VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 vUv;

void main() {
  vec2 position = vec2(
    float((gl_VertexID << 1) & 2),
    float(gl_VertexID & 2)
  );
  vUv = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}
`

export const NORMALIZE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform vec2 uScale;

in vec2 vUv;
out vec4 outColor;

void main() {
  vec2 uv = (vUv - 0.5) * uScale + 0.5;
  outColor = texture(uSource, uv);
}
`

export const MASK_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uBackground;
uniform sampler2D uVideo;
uniform float uThreshold;

in vec2 vUv;
out vec4 outColor;

void main() {
  vec3 videoColor = texture(uVideo, vUv).rgb;
  vec3 backgroundColor = texture(uBackground, vUv).rgb;
  float difference = dot(abs(videoColor - backgroundColor), vec3(1.0));
  float mask = smoothstep(uThreshold - 0.035, uThreshold + 0.035, difference);
  outColor = vec4(mask, 0.0, 0.0, 1.0);
}
`

export const BLUR_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform vec2 uDirection;
uniform vec2 uTexel;

in vec2 vUv;
out vec4 outColor;

void main() {
  float value = texture(uSource, vUv).r * 0.227027;
  value += texture(uSource, vUv + uDirection * uTexel * 1.384615).r * 0.316216;
  value += texture(uSource, vUv - uDirection * uTexel * 1.384615).r * 0.316216;
  value += texture(uSource, vUv + uDirection * uTexel * 3.230769).r * 0.070270;
  value += texture(uSource, vUv - uDirection * uTexel * 3.230769).r * 0.070270;
  outColor = vec4(value, 0.0, 0.0, 1.0);
}
`

export const EFFECT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uBackground;
uniform sampler2D uMask;
uniform sampler2D uVideo;
uniform float uEffectAmount;
uniform float uTime;
uniform int uActive;
uniform int uEffect;
uniform int uGone;
uniform int uHasBackground;

in vec2 vUv;
out vec4 outColor;

float hash21(vec2 point) {
  point = fract(point * vec2(123.34, 456.21));
  point += dot(point, point + 45.32);
  return fract(point.x * point.y);
}

float valueNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 fraction = fract(point);
  fraction = fraction * fraction * (3.0 - 2.0 * fraction);
  float a = hash21(cell);
  float b = hash21(cell + vec2(1.0, 0.0));
  float c = hash21(cell + vec2(0.0, 1.0));
  float d = hash21(cell + vec2(1.0));
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}

float fbm(vec2 point) {
  float value = 0.0;
  value += valueNoise(point) * 0.55;
  value += valueNoise(point * 2.37 + 7.1) * 0.30;
  value += valueNoise(point * 5.91 + 19.7) * 0.15;
  return value;
}

float inside(vec2 uv) {
  vec2 valid = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return valid.x * valid.y;
}

vec4 personAt(vec2 uv) {
  float valid = inside(uv);
  float mask = texture(uMask, uv).r * valid;
  return vec4(texture(uVideo, uv).rgb, mask);
}

vec3 backgroundAt(vec2 uv) {
  return texture(uBackground, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
}

vec3 compositePerson(vec3 background, vec4 person, float alpha) {
  return mix(background, person.rgb, clamp(person.a * alpha, 0.0, 1.0));
}

float smoother(float value) {
  value = clamp(value, 0.0, 1.0);
  return value * value * (3.0 - 2.0 * value);
}

vec2 rotatePoint(vec2 point, float angle) {
  float sine = sin(angle);
  float cosine = cos(angle);
  return mat2(cosine, -sine, sine, cosine) * point;
}

vec3 renderDust(vec3 background) {
  vec4 person = personAt(vUv);
  float threshold = 0.56 * vUv.x + 0.44 * fbm(vUv * vec2(7.0, 11.0));
  float alpha = smoothstep(uEffectAmount - 0.055, uEffectAmount + 0.035, threshold);
  float edge = person.a * (1.0 - smoothstep(0.0, 0.045, abs(threshold - uEffectAmount)));
  vec3 color = compositePerson(background, person, alpha);
  return mix(color, person.rgb * vec3(0.72, 0.62, 0.52), edge * 0.45);
}

vec3 renderBurn(vec3 background) {
  vec4 person = personAt(vUv);
  float threshold = fbm(vUv * vec2(6.0, 9.0) + vec2(0.0, uTime * 0.025));
  float alpha = smoothstep(uEffectAmount - 0.025, uEffectAmount + 0.025, threshold);
  float distanceToEdge = abs(threshold - uEffectAmount);
  float outerGlow = person.a * (1.0 - smoothstep(0.015, 0.075, distanceToEdge));
  float core = person.a * (1.0 - smoothstep(0.0, 0.018, distanceToEdge));
  vec3 color = compositePerson(background, person, alpha);
  color += vec3(1.0, 0.18, 0.015) * outerGlow * 0.75;
  color += vec3(1.0, 0.72, 0.12) * core * 0.8;
  return color;
}

vec3 renderGhost(vec3 background) {
  float scale = 1.0 + 0.065 * uEffectAmount;
  vec2 offset = vec2(0.0, uEffectAmount * 0.045);
  vec2 sourceUv = (vUv - 0.5 - offset) / scale + 0.5;
  vec4 person = personAt(sourceUv);
  float alpha = pow(max(0.0, 1.0 - uEffectAmount), 1.4);
  vec3 color = compositePerson(background, person, alpha);

  vec2 trailUv = sourceUv - vec2(0.0, uEffectAmount * 0.045);
  vec4 trail = personAt(trailUv);
  float trailAlpha = 0.32 * sin(3.14159265 * min(1.0, uEffectAmount * 1.2));
  vec3 spectral = trail.rgb * vec3(0.65, 0.82, 1.0);
  return mix(color, spectral, trail.a * trailAlpha);
}

vec3 renderMelt(vec3 background) {
  float columnNoise = fbm(vec2(vUv.x * 18.0, 3.7));
  float drop = pow(uEffectAmount, 1.7) * (0.22 + 0.68 * columnNoise);
  float stretch = 1.0 + uEffectAmount * 0.85 * columnNoise;
  vec2 sourceUv = vec2(vUv.x, (vUv.y + drop) / stretch);
  vec4 person = personAt(sourceUv);
  float fade = 1.0 - smoother((uEffectAmount - 0.62) / 0.38);
  float drip = smoothstep(0.0, 0.035, person.a);
  return compositePerson(background, person, fade * drip);
}

vec3 renderPortal(vec3 background) {
  vec2 centered = vUv - 0.5;
  float radius = 0.34 * sin(3.14159265 * min(1.0, uEffectAmount * 1.05));
  if (radius <= 0.001) {
    if (uEffectAmount < 0.5) return compositePerson(background, personAt(vUv), 1.0);
    return background;
  }
  float ellipseDistance = length(centered / vec2(1.0, 0.8));
  float portalBody = 1.0 - smoothstep(radius * 0.15, radius, ellipseDistance);
  float portalRim = 1.0 - smoothstep(0.0, 0.025, abs(ellipseDistance - radius * 0.88));
  float swirl = 0.5 + 0.5 * sin(ellipseDistance * 95.0 - uTime * 4.0
    + atan(centered.y, centered.x) * 6.0);
  vec3 portalColor = mix(vec3(0.025, 0.0, 0.08), vec3(0.62, 0.28, 1.0), swirl);
  vec3 color = mix(background, portalColor, portalBody * 0.82);
  color += vec3(0.7, 0.4, 1.0) * portalRim * 0.75;

  float scale = max(0.002, pow(max(0.0, 1.0 - uEffectAmount), 1.3));
  vec2 sourceUv = rotatePoint(centered / scale, -uEffectAmount * uEffectAmount * 3.0) + 0.5;
  vec4 person = personAt(sourceUv);
  float alpha = 1.0 - smoother((uEffectAmount - 0.84) / 0.16);
  return compositePerson(color, person, alpha);
}

float cubicInOut(float value) {
  return value < 0.5
    ? 4.0 * value * value * value
    : 1.0 - pow(-2.0 * value + 2.0, 3.0) * 0.5;
}

vec3 hedgeTexture(vec2 uv, float side) {
  vec2 point = vec2(side < 0.0 ? uv.x : 1.0 - uv.x, uv.y);
  float coarse = valueNoise(point * vec2(26.0, 34.0));
  float fine = valueNoise(point * vec2(74.0, 96.0) + 8.0);
  float vein = 0.5 + 0.5 * sin((point.x + point.y) * 150.0 + fine * 4.0);
  vec3 dark = vec3(0.025, 0.14, 0.025);
  vec3 light = vec3(0.16, 0.48, 0.075);
  return mix(dark, light, clamp(coarse * 0.75 + vein * fine * 0.25, 0.0, 1.0));
}

vec3 renderHedge(vec3 background) {
  const float closedAt = 0.42;
  float closePhase = min(1.0, uEffectAmount / closedAt);
  float close = cubicInOut(closePhase);
  float after = max(0.0, uEffectAmount - closedAt);
  float bounce = exp(-after * 22.0) * sin(after * 55.0) * 0.035;
  float open = smoother((uEffectAmount - 0.58) / 0.42);
  float position = (close + bounce) * (1.0 - open);

  float personScale = 1.0 - 0.16 * smoother(closePhase);
  vec2 personUv = (vUv - vec2(0.5, 0.47)) / personScale + vec2(0.5, 0.47);
  vec4 person = personAt(personUv);
  float personAlpha = 1.0 - smoother((uEffectAmount - closedAt) / 0.025);
  vec3 color = compositePerson(background, person, personAlpha);

  float sway = sin(vUv.y * 31.0 + uTime * 1.6) * 0.008
    + sin(vUv.y * 73.0 - uTime * 2.3) * 0.004;
  float uneven = sin(vUv.y * 17.0) * 0.016 + sin(vUv.y * 53.0 + 1.7) * 0.008;
  float reach = position * 0.55;
  float leftEdge = reach + sway + uneven;
  float rightEdge = 1.0 - reach + sway - uneven;
  float leftMask = 1.0 - smoothstep(leftEdge - 0.012, leftEdge + 0.006, vUv.x);
  float rightMask = smoothstep(rightEdge - 0.006, rightEdge + 0.012, vUv.x);
  vec3 left = hedgeTexture(vUv, -1.0);
  vec3 right = hedgeTexture(vUv, 1.0);
  color = mix(color, left, leftMask);
  return mix(color, right, rightMask);
}

void main() {
  if (uHasBackground == 1 && uActive == 1 && uGone == 1) {
    outColor = vec4(backgroundAt(vUv), 1.0);
    return;
  }
  vec3 videoColor = texture(uVideo, vUv).rgb;
  if (uHasBackground == 0 || uActive == 0) {
    outColor = vec4(videoColor, 1.0);
    return;
  }

  vec3 background = backgroundAt(vUv);
  vec3 color;
  if (uEffect == 0) {
    color = renderDust(background);
  } else if (uEffect == 1) {
    color = renderBurn(background);
  } else if (uEffect == 2) {
    color = renderGhost(background);
  } else if (uEffect == 3) {
    color = renderMelt(background);
  } else if (uEffect == 4) {
    color = renderPortal(background);
  } else {
    color = renderHedge(background);
  }
  float liveMix = 1.0 - smoother(uEffectAmount / 0.12);
  color = mix(color, videoColor, liveMix);
  outColor = vec4(color, 1.0);
}
`

export const PARTICLE_VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec4 aSeed;

uniform sampler2D uMask;
uniform sampler2D uVideo;
uniform float uEffectAmount;
uniform float uTime;
uniform int uEffect;
uniform int uVanishing;
uniform vec2 uResolution;

out vec4 vColor;
out float vRound;

float hash21(vec2 point) {
  point = fract(point * vec2(123.34, 456.21));
  point += dot(point, point + 45.32);
  return fract(point.x * point.y);
}

float valueNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 fraction = fract(point);
  fraction = fraction * fraction * (3.0 - 2.0 * fraction);
  float a = hash21(cell);
  float b = hash21(cell + vec2(1.0, 0.0));
  float c = hash21(cell + vec2(0.0, 1.0));
  float d = hash21(cell + vec2(1.0));
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}

float fbm(vec2 point) {
  return valueNoise(point) * 0.58
    + valueNoise(point * 2.37 + 7.1) * 0.28
    + valueNoise(point * 5.91 + 19.7) * 0.14;
}

void hideParticle() {
  gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  vColor = vec4(0.0);
  vRound = 1.0;
}

void main() {
  vec2 uv = aSeed.xy;
  float mask = texture(uMask, uv).r;
  float direction = uVanishing == 1 ? 1.0 : -1.0;
  float aspect = uResolution.x / max(1.0, uResolution.y);
  vec2 position = uv;
  float visible = 0.0;
  float size = mix(2.0, 6.0, aSeed.z);
  vRound = 0.0;

  if (uEffect == 0) {
    float threshold = 0.56 * uv.x + 0.44 * fbm(uv * vec2(7.0, 11.0));
    float edge = 1.0 - smoothstep(0.02, 0.075, abs(threshold - uEffectAmount));
    float phase = fract(uTime * 0.17 + aSeed.w);
    position += direction * vec2(0.12 + 0.16 * aSeed.z, 0.08 + 0.2 * aSeed.w)
      * phase * edge;
    visible = mask * edge * (1.0 - phase);
    vec3 sourceColor = texture(uVideo, uv).rgb;
    vColor = vec4(mix(sourceColor * 0.55, sourceColor, aSeed.z), visible);
  } else if (uEffect == 1) {
    float threshold = fbm(uv * vec2(6.0, 9.0) + vec2(0.0, uTime * 0.025));
    float edge = 1.0 - smoothstep(0.012, 0.065, abs(threshold - uEffectAmount));
    float phase = fract(uTime * 0.28 + aSeed.w);
    position.x += sin(phase * 14.0 + aSeed.z * 9.0) * 0.018;
    position.y += direction * phase * (0.12 + 0.2 * aSeed.z);
    visible = mask * edge * (1.0 - phase);
    size = mix(2.0, 5.0, aSeed.z);
    vRound = 1.0;
    vColor = vec4(1.0, mix(0.18, 0.72, aSeed.z), 0.025, visible);
  } else if (uEffect == 4) {
    float radius = 0.34 * sin(3.14159265 * min(1.0, uEffectAmount * 1.05));
    float angle = aSeed.x * 6.2831853 + uTime * mix(0.8, 2.4, aSeed.z) * direction;
    float ring = radius * mix(0.82, 1.18, aSeed.y);
    position = vec2(0.5) + vec2(cos(angle) / aspect, sin(angle) * 0.8) * ring;
    visible = smoothstep(0.005, 0.06, radius) * (0.3 + 0.7 * aSeed.w);
    size = mix(2.0, 6.0, aSeed.z);
    vRound = 1.0;
    vColor = vec4(mix(vec3(0.45, 0.16, 1.0), vec3(0.9, 0.7, 1.0), aSeed.z), visible);
  } else if (uEffect == 5) {
    float hit = exp(-pow((uEffectAmount - 0.45) / 0.075, 2.0));
    float phase = fract(uTime * 0.13 + aSeed.w);
    position.x = 0.5 + (aSeed.x - 0.5) * 0.12 + (aSeed.z - 0.5) * phase * 0.3;
    position.y = aSeed.y + direction * phase * (0.08 + 0.2 * aSeed.z);
    visible = hit * (1.0 - phase);
    size = mix(3.0, 8.0, aSeed.z);
    vRound = 0.5;
    vColor = vec4(mix(vec3(0.08, 0.28, 0.025), vec3(0.32, 0.65, 0.09), aSeed.w), visible);
  } else {
    hideParticle();
    return;
  }

  if (visible < 0.01 || position.x < -0.1 || position.x > 1.1
    || position.y < -0.1 || position.y > 1.1) {
    hideParticle();
    return;
  }

  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = size;
}
`

export const PARTICLE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec4 vColor;
in float vRound;
out vec4 outColor;

void main() {
  vec2 centered = gl_PointCoord * 2.0 - 1.0;
  float roundAlpha = 1.0 - smoothstep(0.72, 1.0, dot(centered, centered));
  float leaf = 1.0 - smoothstep(0.36, 1.0, abs(centered.x) + abs(centered.y) * 0.45);
  float shape = mix(1.0, roundAlpha, step(0.75, vRound));
  shape = mix(shape, leaf, step(0.25, vRound) * (1.0 - step(0.75, vRound)));
  if (shape * vColor.a < 0.01) discard;
  outColor = vec4(vColor.rgb, vColor.a * shape);
}
`
