# In-app native Fabric view: 通用 Liquid Glass 卡片容器（UIVisualEffectView + UIGlassEffect）。
# iOS 26+ 提供材质 + 可选 interactive press scale；React children mount 在 effect contentView。
require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'BouncyGlassCard'
  s.version          = package['version']
  s.summary          = 'Native iOS Liquid Glass card container for FlopsMobile.'
  s.homepage         = 'https://github.com/Xenotech-Studio/FlopsMobile'
  s.license          = 'MIT'
  s.author           = 'FlopsMobile Team'
  s.platforms        = { :ios => '15.1' }
  s.source           = { :git => '' }
  s.source_files     = '*.{h,mm,m}'
  s.requires_arc     = true

  install_modules_dependencies(s)
end
