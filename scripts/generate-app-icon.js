/**
 * 从 FlopsWeb 的透明图标生成应用图标（白底），并输出到 Android / iOS 所需尺寸。
 * 用法：在 FlopsMobile 根目录执行 yarn generate-app-icon 或 node scripts/generate-app-icon.js
 * 依赖：sharp（已加入 devDependencies）
 */

const path = require('path');
const fs = require('fs');

const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SOURCE_ICON = path.join(ROOT, '..', 'FlopsWeb', 'src', 'assets', 'Icon_Flops_Thin_no_border.png');
/** 图标相对画布的内边距比例（每边），例如 0.1 表示左右上下各留 10%，图标约占 80% */
const PADDING_RATIO = 0.1;

const ANDROID_SIZES = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 },
];

const IOS_IMAGES = [
  { size: '20x20', scale: '2x', pixelSize: 40, filename: 'Icon-20@2x.png' },
  { size: '20x20', scale: '3x', pixelSize: 60, filename: 'Icon-20@3x.png' },
  { size: '29x29', scale: '2x', pixelSize: 58, filename: 'Icon-29@2x.png' },
  { size: '29x29', scale: '3x', pixelSize: 87, filename: 'Icon-29@3x.png' },
  { size: '40x40', scale: '2x', pixelSize: 80, filename: 'Icon-40@2x.png' },
  { size: '40x40', scale: '3x', pixelSize: 120, filename: 'Icon-40@3x.png' },
  { size: '60x60', scale: '2x', pixelSize: 120, filename: 'Icon-60@2x.png' },
  { size: '60x60', scale: '3x', pixelSize: 180, filename: 'Icon-60@3x.png' },
  { size: '1024x1024', scale: '1x', pixelSize: 1024, filename: 'Icon-1024.png' },
];

async function main() {
  if (!fs.existsSync(SOURCE_ICON)) {
    console.error('Source icon not found:', SOURCE_ICON);
    console.error('Ensure FlopsWeb is a sibling of FlopsMobile and the asset path is correct.');
    process.exit(1);
  }

  const whiteBackground = { r: 255, g: 255, b: 255, alpha: 1 };
  const sourceWithWhite = await sharp(SOURCE_ICON)
    .flatten({ background: whiteBackground })
    .toBuffer();

  /** 生成带边距的图标：画布 size×size，图标缩小后居中 */
  async function iconWithPadding(size) {
    const pad = Math.round(size * PADDING_RATIO);
    const iconSize = size - pad * 2;
    const iconBuf = await sharp(sourceWithWhite)
      .resize(iconSize, iconSize)
      .toBuffer();
    return sharp({
      create: { width: size, height: size, channels: 4, background: whiteBackground },
    })
      .composite([{ input: iconBuf, left: pad, top: pad }])
      .png()
      .toBuffer();
  }

  console.log('Generating Android mipmap icons (white background + padding)...');
  for (const { dir, size } of ANDROID_SIZES) {
    const outDir = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', dir);
    fs.mkdirSync(outDir, { recursive: true });
    const buf = await iconWithPadding(size);
    await sharp(buf).toFile(path.join(outDir, 'ic_launcher.png'));
    await sharp(buf).toFile(path.join(outDir, 'ic_launcher_round.png'));
    console.log('  ', dir, size + 'x' + size);
  }

  const iosDir = path.join(ROOT, 'ios', 'FlopsMobile', 'Images.xcassets', 'AppIcon.appiconset');
  fs.mkdirSync(iosDir, { recursive: true });
  console.log('Generating iOS AppIcon (white background + padding)...');
  const contents = {
    images: [],
    info: { author: 'xcode', version: 1 },
  };
  for (const { size, scale, pixelSize, filename } of IOS_IMAGES) {
    const buf = await iconWithPadding(pixelSize);
    await sharp(buf).toFile(path.join(iosDir, filename));
    contents.images.push({
      idiom: size === '1024x1024' ? 'ios-marketing' : 'iphone',
      scale,
      size,
      filename,
    });
    console.log('  ', filename, pixelSize + 'x' + pixelSize);
  }
  fs.writeFileSync(
    path.join(iosDir, 'Contents.json'),
    JSON.stringify(contents, null, 2)
  );
  console.log('Done. Android and iOS app icons updated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
