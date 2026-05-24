# In-app native Fabric view: iOS UISegmentedControl 包装。iOS 26+ 自动 Liquid Glass material。
# 在 ios/Podfile 里通过 `pod 'BouncySegmentedControl', :path => './BouncySegmentedControl'` 引入。
require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'BouncySegmentedControl'
  s.version          = package['version']
  s.summary          = 'Native iOS UISegmentedControl Fabric wrapper for FlopsMobile.'
  s.homepage         = 'https://github.com/Xenotech-Studio/FlopsMobile'
  s.license          = 'MIT'
  s.author           = 'FlopsMobile Team'
  s.platforms        = { :ios => '15.1' }
  s.source           = { :git => '' }
  s.source_files     = '*.{h,mm,m}'
  s.requires_arc     = true

  install_modules_dependencies(s)
end
