# In-app native Fabric view for BouncyButton (iOS only, RN 0.84+).
# 在 ios/Podfile 里通过 `pod 'BouncyButton', :path => './BouncyButton'` 引入。
require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'BouncyButton'
  s.version          = package['version']
  s.summary          = 'Native iOS bouncy press-feedback button view for FlopsMobile.'
  s.homepage         = 'https://github.com/Xenotech-Studio/FlopsMobile'
  s.license          = 'MIT'
  s.author           = 'FlopsMobile Team'
  s.platforms        = { :ios => '15.1' }
  s.source           = { :git => '' }
  s.source_files     = '*.{h,mm,m}'
  s.requires_arc     = true

  install_modules_dependencies(s)
end
