# In-app native Fabric view: 独立 UITabBar 包装。iOS 26+ 自动 Liquid Glass floating tab bar 视觉。
require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'BouncyTabBar'
  s.version          = package['version']
  s.summary          = 'Native iOS UITabBar Fabric wrapper for FlopsMobile (standalone, not UITabBarController).'
  s.homepage         = 'https://github.com/Xenotech-Studio/FlopsMobile'
  s.license          = 'MIT'
  s.author           = 'FlopsMobile Team'
  s.platforms        = { :ios => '15.1' }
  s.source           = { :git => '' }
  s.source_files     = '*.{h,mm,m}'
  s.requires_arc     = true

  install_modules_dependencies(s)
end
