{
  description = "pi coding agent extension development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              git
              direnv
            ];

            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"

              echo "pi extension dev shell"
              echo "  npm install        # install TypeScript and pi packages"
              echo "  npm run typecheck  # type-check the extension"
              echo "  npm run dev        # launch pi with this extension"
            '';
          };
        });
    };
}
