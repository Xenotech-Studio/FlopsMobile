#!/usr/bin/env ruby
# 用 xcodeproj gem 往 FlopsMobile.xcodeproj 里加一个 WidgetExtension target（FlopsBroadcastActivity），
# 承载播报模式的 Live Activity（灵动岛 / 锁屏）。手改 pbxproj 易错，改用 gem 编程式生成。
#
# 幂等：已存在同名 target 直接跳过。运行（借 CocoaPods 自带的 xcodeproj gem）：
#   GEM_HOME=/opt/homebrew/Cellar/cocoapods/<ver>/libexec ruby ios/scripts/add_broadcast_activity_target.rb
require 'xcodeproj'

PROJECT_PATH = File.expand_path(File.join(__dir__, '..', 'FlopsMobile.xcodeproj'))
APP_TARGET_NAME = 'FlopsMobile'
EXT_TARGET_NAME = 'FlopsBroadcastActivity'
TEAM = '9WLTK2DC27'
DEPLOYMENT = '16.1'

project = Xcodeproj::Project.open(PROJECT_PATH)

app_target = project.targets.find { |t| t.name == APP_TARGET_NAME }
raise "app target #{APP_TARGET_NAME} not found" unless app_target

if project.targets.any? { |t| t.name == EXT_TARGET_NAME }
  puts "target #{EXT_TARGET_NAME} already exists — nothing to do"
  exit 0
end

# 1) 新建 app_extension target（部署目标 16.1；Live Activity 需 16.1+）
ext_target = project.new_target(:app_extension, EXT_TARGET_NAME, :ios, DEPLOYMENT)

# 2) 文件分组 + 文件引用（widget 侧源码放 ios/FlopsBroadcastActivity/）
ext_group = project.main_group.new_group(EXT_TARGET_NAME, EXT_TARGET_NAME)
live_ref  = ext_group.new_reference('FlopsBroadcastLiveActivity.swift')
attrs_ref = ext_group.new_reference('FlopsBroadcastAttributes.swift')
plist_ref = ext_group.new_reference('Info.plist')

# widget target 编译 UI + 共享 attributes
ext_target.add_file_references([live_ref, attrs_ref])
# 共享 attributes 也编入主 App target（双 membership，二者须是同一类型）
app_target.add_file_references([attrs_ref])

# 3) 主 App 侧 ActivityKit 管理器：放进既有 FlopsMobile 分组 + 主 App target
flops_group = project.main_group.children.find { |c| c.display_name == APP_TARGET_NAME }
raise "group #{APP_TARGET_NAME} not found" unless flops_group
mgr_ref = flops_group.new_reference('FlopsMobile/FlopsActivityManager.swift')
mgr_ref.name = 'FlopsActivityManager.swift'
app_target.add_file_references([mgr_ref])

# 4) widget target 的 build settings（Debug / Release 共性 + 各自差异）
common = {
  'CLANG_ENABLE_MODULES'         => 'YES',
  'CODE_SIGN_STYLE'              => 'Automatic',
  'CURRENT_PROJECT_VERSION'      => '20',
  'DEVELOPMENT_TEAM'             => TEAM,
  'GENERATE_INFOPLIST_FILE'      => 'NO',
  'INFOPLIST_FILE'               => 'FlopsBroadcastActivity/Info.plist',
  'IPHONEOS_DEPLOYMENT_TARGET'   => DEPLOYMENT,
  'LD_RUNPATH_SEARCH_PATHS'      => ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks'],
  'MARKETING_VERSION'            => '0.1.5',
  'PRODUCT_NAME'                 => '$(TARGET_NAME)',
  'SWIFT_EMIT_LOC_STRINGS'       => 'YES',
  'SWIFT_VERSION'                => '5.0',
  'TARGETED_DEVICE_FAMILY'       => '1,2',
}

debug_only = {
  'PRODUCT_BUNDLE_IDENTIFIER'                  => 'org.reactjs.native.example.FlopsMobile.BroadcastActivity',
  'PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]'   => 'com.xenotech.FlopsMobile.dev.BroadcastActivity',
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS'        => 'DEBUG',
  'SWIFT_OPTIMIZATION_LEVEL'                   => '-Onone',
  'DEBUG_INFORMATION_FORMAT'                   => 'dwarf',
  'MTL_ENABLE_DEBUG_INFO'                      => 'INCLUDE_SOURCE',
  'ONLY_ACTIVE_ARCH'                           => 'YES',
  'GCC_PREPROCESSOR_DEFINITIONS'               => ['DEBUG=1', '$(inherited)'],
}

release_only = {
  'PRODUCT_BUNDLE_IDENTIFIER'                  => 'org.reactjs.native.example.FlopsMobile.BroadcastActivity',
  'PRODUCT_BUNDLE_IDENTIFIER[sdk=iphoneos*]'   => 'com.xenotech.FlopsMobile.BroadcastActivity',
  'SWIFT_OPTIMIZATION_LEVEL'                   => '-O',
  'DEBUG_INFORMATION_FORMAT'                   => 'dwarf-with-dsym',
  'MTL_ENABLE_DEBUG_INFO'                      => 'NO',
  'COPY_PHASE_STRIP'                           => 'NO',
}

ext_target.build_configurations.each do |config|
  config.build_settings.merge!(common)
  config.build_settings.merge!(config.name == 'Debug' ? debug_only : release_only)
end

# 5) 主 App 里加「Embed App Extensions」copy-files 阶段，把 .appex 拷进 PlugIns
embed_phase = app_target.new_copy_files_build_phase('Embed Foundation Extensions')
embed_phase.symbol_dst_subfolder_spec = :plug_ins
build_file = embed_phase.add_file_reference(ext_target.product_reference)
build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }

# 6) 主 App 依赖 widget（保证先建 widget、再嵌入）
app_target.add_dependency(ext_target)

# 7) TargetAttributes（自动签名）
attrs = project.root_object.attributes
attrs['TargetAttributes'] ||= {}
attrs['TargetAttributes'][ext_target.uuid] = {
  'CreatedOnToolsVersion' => '15.0',
  'ProvisioningStyle'     => 'Automatic',
}

project.save
puts "added target #{EXT_TARGET_NAME}; targets now: #{project.targets.map(&:name).join(', ')}"
