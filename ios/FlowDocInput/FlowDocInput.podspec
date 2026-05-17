# In-app native module for FlowDocInput (Fabric-only, RN 0.84+).
# 在 ios/Podfile 里通过 `pod 'FlowDocInput', :path => './FlowDocInput'` 引入。
require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'FlowDocInput'
  s.version          = package['version']
  s.summary          = 'Native rich-text input with atomic ref-pill attachments for FlopsMobile.'
  s.homepage         = 'https://github.com/Xenotech-Studio/FlopsMobile'
  s.license          = 'MIT'
  s.author           = 'FlopsMobile Team'
  s.platforms        = { :ios => '15.1' }
  s.source           = { :git => '' }
  s.source_files     = '*.{h,mm,m}'
  s.requires_arc     = true

  # Fabric + new arch dependencies (会由 install_modules_dependencies 自动接入)
  install_modules_dependencies(s)
end
