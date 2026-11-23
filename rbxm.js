'use strict';

/**
 * Dựng file .rbxm (Roblox binary model) chứa KeyframeSequence -> Keyframe -> Pose.
 * Không cần thư viện ngoài: các chunk được ghi dạng không nén (compressedLength = 0),
 * đây là dạng hợp lệ trong đặc tả định dạng RBXM.
 */

const IDENTITY = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

// AnimationPriority enum
const PRIORITY = { Idle: 0, Movement: 1, Action: 2, Action2: 3, Action3: 4, Action4: 5, Core: 1000 };

// Cây khớp (Pose lồng nhau theo đúng cấu trúc rig, Roblox yêu cầu điều này để animation chạy đúng)
const HIERARCHY = {
  R15: {
    HumanoidRootPart: null,
    LowerTorso: 'HumanoidRootPart',
    UpperTorso: 'LowerTorso',
    Head: 'UpperTorso',
    LeftUpperArm: 'UpperTorso',
    LeftLowerArm: 'LeftUpperArm',
    LeftHand: 'LeftLowerArm',
    RightUpperArm: 'UpperTorso',
    RightLowerArm: 'RightUpperArm',
    RightHand: 'RightLowerArm',
    LeftUpperLeg: 'LowerTorso',
    LeftLowerLeg: 'LeftUpperLeg',
    LeftFoot: 'LeftLowerLeg',
    RightUpperLeg: 'LowerTorso',
    RightLowerLeg: 'RightUpperLeg',
    RightFoot: 'RightLowerLeg',
  },
  R6: {
    HumanoidRootPart: null,
    Torso: 'HumanoidRootPart',
    Head: 'Torso',
    'Left Arm': 'Torso',
    'Right Arm': 'Torso',
    'Left Leg': 'Torso',
    'Right Leg': 'Torso',
  },
};

// ---------- Bộ mã hoá mức thấp ----------

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function str(s) {
  const data = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(data.length), data]);
}

// Xen kẽ byte: toàn bộ byte cao nhất của mọi phần tử trước, rồi tới byte kế tiếp...
function interleave(values) {
  const n = values.length;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = values[i] >>> 0;
    out[i] = v >>> 24;
    out[n + i] = (v >>> 16) & 0xff;
    out[2 * n + i] = (v >>> 8) & 0xff;
    out[3 * n + i] = v & 0xff;
  }
  return out;
}

const zigzag = (n) => ((n << 1) ^ (n >> 31)) >>> 0;

// Mảng referent: delta + zigzag + xen kẽ
function refsToBuf(refs) {
  let prev = 0;
  return interleave(
    refs.map((r) => {
      const d = r - prev;
      prev = r;
      return zigzag(d);
    }),
  );
}

// Float32 kiểu Roblox: xoay trái 1 bit rồi xen kẽ
function floatBits(f) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(f);
  const bits = b.readUInt32LE(0);
  return ((bits << 1) | (bits >>> 31)) >>> 0;
}
const floatsToBuf = (values) => interleave(values.map(floatBits));

function cframesToBuf(list) {
  const parts = [];
  for (const c of list) {
    const b = Buffer.alloc(37);
    b[0] = 0; // rotation id 0 = ma trận xoay 3x3 ghi thẳng ra
    for (let i = 0; i < 9; i++) b.writeFloatLE(c[3 + i], 1 + i * 4);
    parts.push(b);
  }
  // Vị trí: mảng X, mảng Y, mảng Z
  parts.push(floatsToBuf(list.map((c) => c[0])));
  parts.push(floatsToBuf(list.map((c) => c[1])));
  parts.push(floatsToBuf(list.map((c) => c[2])));
  return Buffer.concat(parts);
}

function chunk(name, data) {
  const header = Buffer.alloc(16);
  header.write(name.padEnd(4, '\0'), 0, 'latin1');
  header.writeUInt32LE(0, 4); // compressed length = 0 -> dữ liệu không nén
  header.writeUInt32LE(data.length, 8);
  // 4 byte cuối: reserved = 0
  return Buffer.concat([header, data]);
}

const TYPE_ID = { String: 0x01, Bool: 0x02, Float: 0x04, CFrame: 0x10, Enum: 0x12 };

const ENCODERS = {
  String: (vals) => Buffer.concat(vals.map((v) => str(v))),
  Bool: (vals) => Buffer.from(vals.map((v) => (v ? 1 : 0))),
  Float: floatsToBuf,
  CFrame: cframesToBuf,
  Enum: (vals) => interleave(vals),
};

const SCHEMA = {
  KeyframeSequence: [
    ['Name', 'String'],
    ['Loop', 'Bool'],
    ['Priority', 'Enum'],
  ],
  Keyframe: [
    ['Name', 'String'],
    ['Time', 'Float'],
  ],
  Pose: [
    ['Name', 'String'],
    ['CFrame', 'CFrame'],
    ['EasingDirection', 'Enum'], // 0 = In
    ['EasingStyle', 'Enum'], // 0 = Linear
    ['Weight', 'Float'],
  ],
};

// ---------- Dựng cây Pose ----------

function detectRig(rigType, partNames) {
  const s = String(rigType ?? '').toUpperCase();
  if (s.includes('R6')) return 'R6';
  if (s.includes('R15')) return 'R15';
  const names = new Set(partNames);
  if (['UpperTorso', 'LowerTorso', 'LeftUpperArm'].some((n) => names.has(n))) return 'R15';
  if (['Torso', 'Left Arm', 'Right Arm', 'Left Leg', 'Right Leg'].some((n) => names.has(n))) return 'R6';
  return null; // không rõ rig -> để Pose phẳng
}

// poses: Map<tên part, 12 số CFrame>. Part cha còn thiếu sẽ được bù bằng Pose Weight = 0.
function buildPoseTree(poses, parentOf) {
  const nodes = new Map();
  const roots = [];
  const ensure = (name) => {
    let node = nodes.get(name);
    if (node) return node;
    const cf = poses.get(name);
    node = { name, cframe: cf ?? IDENTITY, weight: cf ? 1 : 0, children: [] };
    nodes.set(name, node);
    const parentName = parentOf && Object.hasOwn(parentOf, name) ? parentOf[name] : null;
    (parentName ? ensure(parentName).children : roots).push(node);
    return node;
  };
  for (const name of poses.keys()) ensure(name);
  return roots;
}

// ---------- Hàm chính ----------

/**
 * @param {{name:string, rigType?:string, loop?:boolean, priority?:string,
 *          keyframes:{time:number, poses:Map<string, number[]>}[]}} animation
 * @returns {Buffer} nội dung file .rbxm
 */
function buildAnimationRbxm(animation) {
  const { name, keyframes, rigType, loop = false, priority = 'Action' } = animation;

  const allParts = keyframes.flatMap((k) => [...k.poses.keys()]);
  const rig = detectRig(rigType, allParts);
  const parentOf = rig ? HIERARCHY[rig] : null;

  const instances = []; // referent = chỉ số trong mảng
  const add = (className, parent, props) => {
    instances.push({ className, parent, props });
    return instances.length - 1;
  };

  const addPose = (node, parentRef) => {
    const ref = add('Pose', parentRef, {
      Name: node.name,
      CFrame: node.cframe,
      EasingDirection: 0,
      EasingStyle: 0,
      Weight: node.weight,
    });
    node.children.forEach((c) => addPose(c, ref));
  };

  const root = add('KeyframeSequence', -1, {
    Name: name,
    Loop: Boolean(loop),
    Priority: PRIORITY[priority] ?? PRIORITY.Action,
  });
  for (const kf of keyframes) {
    const kfRef = add('Keyframe', root, { Name: 'Keyframe', Time: kf.time });
    buildPoseTree(kf.poses, parentOf).forEach((n) => addPose(n, kfRef));
  }

  const classNames = [...new Set(instances.map((i) => i.className))];
  const classId = Object.fromEntries(classNames.map((n, i) => [n, i]));

  const chunks = [];

  // INST: khai báo từng class và danh sách referent
  for (const cls of classNames) {
    const refs = [];
    instances.forEach((inst, i) => inst.className === cls && refs.push(i));
    chunks.push(
      chunk('INST', Buffer.concat([u32(classId[cls]), str(cls), Buffer.from([0]), u32(refs.length), refsToBuf(refs)])),
    );
  }

  // PROP: từng thuộc tính của từng class
  for (const cls of classNames) {
    const members = instances.filter((i) => i.className === cls);
    for (const [prop, type] of SCHEMA[cls]) {
      const payload = ENCODERS[type](members.map((m) => m.props[prop]));
      chunks.push(
        chunk('PROP', Buffer.concat([u32(classId[cls]), str(prop), Buffer.from([TYPE_ID[type]]), payload])),
      );
    }
  }

  // PRNT: quan hệ cha-con
  const n = instances.length;
  chunks.push(
    chunk(
      'PRNT',
      Buffer.concat([
        Buffer.from([0]),
        u32(n),
        refsToBuf(instances.map((_, i) => i)),
        refsToBuf(instances.map((i) => i.parent)),
      ]),
    ),
  );

  chunks.push(chunk('END', Buffer.from('</roblox>', 'latin1')));

  // Header 32 byte
  const header = Buffer.alloc(32);
  header.write('<roblox!', 0, 'latin1');
  Buffer.from([0x89, 0xff, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 8);
  header.writeUInt16LE(0, 14); // version
  header.writeInt32LE(classNames.length, 16);
  header.writeInt32LE(n, 20);

  return Buffer.concat([header, ...chunks]);
}

module.exports = { buildAnimationRbxm };
